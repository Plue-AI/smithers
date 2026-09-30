//! The same bounded glob grammar for every native filesystem backend.
use std::io;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

struct GlobAlternative {
    pattern: String,
    segments: Vec<GlobSegment>,
    directory_only: bool,
    root_only: bool,
    dot_anchor: bool,
    trailing_globstar: bool,
    literal_core: bool,
    impossible_dot_segment: bool,
}
enum GlobSegment {
    Recursive,
    Pattern {
        explicit_dot: bool,
        matcher: globset::GlobMatcher,
    },
}
pub(super) struct GlobRule {
    alternatives: Vec<GlobAlternative>,
    anchor: bool,
}
impl GlobRule {
    pub(super) fn new(pattern: &str, anchor: bool) -> io::Result<Self> {
        if pattern.len() > 4096 {
            return Err(invalid("unsupported glob pattern"));
        }
        let mut alternatives = Vec::new();
        for expanded in expand_braces(pattern)? {
            alternatives.push(GlobAlternative::new(&expanded)?);
        }
        Ok(Self {
            alternatives,
            anchor,
        })
    }
    pub(super) fn matches(&self, path: &str, is_directory: bool) -> bool {
        self.alternatives
            .iter()
            .any(|rule| rule.matches(path, is_directory, self.anchor))
    }
    pub(super) fn includes_root(&self) -> bool {
        self.alternatives.iter().any(|alt| alt.root_only)
    }
    pub(super) fn below(&self, path: &str) -> bool {
        self.alternatives.iter().any(|rule| rule.below(path))
    }
}
impl GlobAlternative {
    fn new(pattern: &str) -> io::Result<Self> {
        // Brace alternatives have independent class boundaries. Validate the
        // actual pattern being compiled, after bounded brace expansion.
        let normalized = normalize_glob(pattern)?;
        let directory_only = pattern.ends_with('/');
        let trimmed = pattern.trim_end_matches('/');
        let dot_anchor = trimmed == "[.]" || trimmed.ends_with("/[.]");
        let impossible_dot_segment = pattern.split('/').rev().skip(1).any(|part| part == "[.]");
        let mut parsed = normalized.trim_end_matches('/').to_owned();
        while parsed.contains("//") {
            parsed = parsed.replace("//", "/");
        }
        let parsed = parsed.trim_start_matches("./");
        let parsed = if dot_anchor {
            parsed.trim_end_matches("/.").to_owned()
        } else {
            parsed.to_owned()
        };
        let parsed = parsed.trim_end_matches('/');
        // Adjacent globstars describe the same depths as one globstar. Collapse
        // them before deriving the anchor so a remaining terminal globstar
        // cannot require a descendant when selecting the zero-depth anchor.
        let mut parts = parsed.split('/').collect::<Vec<_>>();
        parts.dedup_by(|a, b| *a == "**" && *b == "**");
        let parsed = parts.join("/");
        let parsed = parsed.as_str();
        let root_only = parsed.is_empty() || parsed == ".";
        let trailing_globstar = parsed == "**" || parsed.ends_with("/**");
        let core = if trailing_globstar {
            parsed.strip_suffix("/**").unwrap_or("")
        } else {
            parsed
        };
        let literal_core = !core.contains(['*', '?', '[', '{']);
        let escaped = parsed.replace('{', "\\{").replace('}', "\\}");
        let escaped = if escaped.is_empty() {
            ".".to_owned()
        } else {
            escaped
        };
        // Separators end a segment even inside brackets. An unclosed class
        // therefore remains literal within that segment, as in Node's globber.
        let segments = escaped
            .split('/')
            .map(|segment| {
                if segment == "**" {
                    return Ok(GlobSegment::Recursive);
                }
                Ok(GlobSegment::Pattern {
                    explicit_dot: segment.starts_with('.'),
                    matcher: globset::GlobBuilder::new(segment)
                        .literal_separator(true)
                        .backslash_escape(true)
                        .empty_alternates(true)
                        .allow_unclosed_class(true)
                        .build()
                        .map_err(|_| invalid("glob segment"))?
                        .compile_matcher(),
                })
            })
            .collect::<io::Result<Vec<_>>>()?;
        Ok(Self {
            pattern: parsed.to_owned(),
            segments,
            directory_only,
            root_only,
            dot_anchor,
            trailing_globstar,
            literal_core,
            impossible_dot_segment,
        })
    }
    fn matches(&self, path: &str, is_directory: bool, anchor: bool) -> bool {
        if self.impossible_dot_segment {
            return false;
        }
        if self.dot_anchor
            && (!anchor
                || !(is_directory || self.literal_core)
                || self.pattern == "**"
                || self.pattern.ends_with("/**"))
        {
            return false;
        }
        (!self.directory_only || is_directory)
            && (if path.is_empty() {
                anchor && (self.root_only || self.pattern == "**")
            } else {
                !self.root_only
                    && (Self::matches_segments(&self.segments, path, false)
                        || (anchor
                            && self.trailing_globstar
                            && (is_directory || self.literal_core)
                            && self.anchor_matches(path))
                        || (self.dot_anchor && self.pattern == path))
            })
    }
    fn anchor_matches(&self, path: &str) -> bool {
        self.segments.len() > 1
            && Self::matches_segments(&self.segments[..self.segments.len() - 1], path, false)
    }
    fn matches_segments(segments: &[GlobSegment], path: &str, descendants: bool) -> bool {
        let parts: Vec<_> = path.split('/').collect();
        // A dot in one segment cannot authorize a different hidden segment.
        // Keep globset responsible for segment syntax, and align globstars
        // without recursive backtracking: each may consume only visible names.
        let mut matched = vec![false; parts.len() + 1];
        let mut next = vec![false; parts.len() + 1];
        matched[0] = true;
        for (segment_index, segment) in segments.iter().enumerate() {
            next.fill(false);
            match segment {
                GlobSegment::Recursive => {
                    // A terminal globstar addresses descendants. Selecting
                    // its zero-depth anchor is handled separately above.
                    let can_be_empty = descendants || segment_index + 1 < segments.len();
                    next[0] = can_be_empty && matched[0];
                    for (index, part) in parts.iter().enumerate() {
                        next[index + 1] = (can_be_empty && matched[index + 1])
                            || ((matched[index] || next[index]) && !part.starts_with('.'));
                    }
                }
                GlobSegment::Pattern {
                    explicit_dot,
                    matcher,
                } => {
                    for (index, part) in parts.iter().enumerate() {
                        next[index + 1] = matched[index]
                            && (!part.starts_with('.') || *explicit_dot)
                            && matcher.is_match(part);
                    }
                }
            }
            // A traversal prefix must leave a segment that can address a
            // descendant, or a globstar that can consume another visible name.
            if descendants
                && next[parts.len()]
                && (segment_index + 1 < segments.len() || matches!(segment, GlobSegment::Recursive))
            {
                return true;
            }
            std::mem::swap(&mut matched, &mut next);
        }
        !descendants && matched[parts.len()]
    }
    fn below(&self, path: &str) -> bool {
        if self.impossible_dot_segment {
            return false;
        }
        if self.root_only {
            return false;
        }
        if path.is_empty() {
            return true;
        }
        Self::matches_segments(&self.segments, path, true)
    }
}
fn split_alternatives(body: &str) -> Option<Vec<String>> {
    let mut depth = 0;
    let mut members = Vec::new();
    let mut start = 0;
    for (index, ch) in body.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => depth -= 1,
            ',' if depth == 0 => {
                members.push(body[start..index].to_owned());
                start = index + 1;
            }
            _ => {}
        }
    }
    if members.is_empty() {
        None
    } else {
        members.push(body[start..].to_owned());
        Some(members)
    }
}
fn expand_braces(pattern: &str) -> io::Result<Vec<String>> {
    let mut queue = vec![pattern.to_owned()];
    let mut out = Vec::new();
    while let Some(text) = queue.pop() {
        let mut stack = Vec::new();
        let mut groups = Vec::new();
        let mut expanded = false;
        for (index, ch) in text.char_indices() {
            if ch == '{' {
                stack.push(index);
            } else if ch == '}' {
                if let Some(start) = stack.pop() {
                    groups.push((start, index));
                }
            }
        }
        groups.sort_by_key(|(start, _)| *start);
        for (start, end) in groups {
            let body = &text[start + 1..end];
            if body.contains("..") {
                return Err(invalid("brace range"));
            }
            if let Some(members) = split_alternatives(body) {
                for member in members {
                    queue.push(format!("{}{}{}", &text[..start], member, &text[end + 1..]));
                }
                expanded = true;
                break;
            }
        }
        if out.len() + queue.len() > 64 {
            return Err(invalid("glob pattern expands past 64 alternatives"));
        }
        if !expanded {
            out.push(text);
        }
    }
    Ok(out)
}
// Validate syntax and normalize dot classes using the same character-class boundaries.
fn normalize_glob(pattern: &str) -> io::Result<String> {
    let mut class_first = None;
    let bytes = pattern.as_bytes();
    let mut normalized = String::with_capacity(pattern.len());
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len().saturating_sub(1) {
        if class_first.is_none() && bytes[index..].starts_with(b"[.]") {
            normalized.push_str(&pattern[copied..index]);
            normalized.push('.');
            index += 3;
            copied = index;
            continue;
        }
        // A POSIX class can follow literal members inside an outer class.
        // A new class after a closed literal-bracket class is ordinary syntax.
        if class_first.is_some() && bytes[index] == b'[' && bytes[index + 1] == b':' {
            return Err(invalid("unsupported glob pattern"));
        }
        match bytes[index] {
            b'[' if class_first.is_none() => {
                // A leading ']' is a literal member, including after class
                // negation. Only a later ']' closes the class.
                let negated = matches!(bytes.get(index + 1), Some(b'!' | b'^'));
                class_first = Some(index + 1 + usize::from(negated));
            }
            b']' if class_first.is_some_and(|first| index > first) => class_first = None,
            b'/' => class_first = None,
            _ => {}
        }
        if class_first.is_none() && bytes[index + 1] == b'(' && b"@+?!*".contains(&bytes[index]) {
            return Err(invalid("unsupported glob pattern"));
        }
        index += 1;
    }
    normalized.push_str(&pattern[copied..]);
    Ok(normalized)
}
pub(super) fn relative_pattern(pattern: &str, base: &str, exclusion: bool) -> String {
    if pattern.contains('\\') && !exclusion && !pattern.starts_with('/') {
        return "\0".to_owned();
    }
    let normalized = if exclusion || pattern.starts_with('/') {
        pattern.replace('\\', "")
    } else {
        pattern.to_owned()
    };
    // One exact-root rule for every spelling: trailing separators on the base
    // or the pattern never change which directory the pattern names.
    let root = base.trim_end_matches('/');
    let stripped = normalized
        .strip_prefix(root)
        .filter(|value| value.is_empty() || value.starts_with('/'))
        .map(|value| value.trim_start_matches('/'))
        .unwrap_or(&normalized)
        .trim_start_matches("./");
    stripped.to_owned()
}

#[cfg(test)]
mod tests {
    use super::{relative_pattern, GlobRule};

    #[test]
    fn dot_class_normalization_respects_outer_character_classes() {
        for anchor in [false, true] {
            for (pattern, path, expected) in [
                ("[[.]]", "[]", true),
                ("[[.]]", "[.]", false),
                ("[a[.]b]", "ab]", true),
                ("[a[.]b]", "[b]", true),
                ("[a[.]b]", "a", false),
                ("[a[.]b]", "b", false),
                ("[][.]b]", "]b]", true),
                ("[][.]b]", "ab]", false),
                ("[!a[.]b]", "bb]", true),
                ("[!a[.]b]", "ab]", false),
                ("[^a[.]b]", "bb]", true),
                ("[^a[.]b]", "[b]", false),
                ("x]/[[.]]", "x]/[]", true),
                ("[a[.]/x", "[/x", true),
                ("[a[.]/x", "a/x", true),
                ("é[[.]]", "é[]", true),
                ("é[.]txt", "é.txt", true),
                ("{[[.]],[a[.]b]}", "[]", true),
                ("{[[.]],[a[.]b]}", "ab]", true),
                ("[.]hidden/file", ".hidden/file", true),
                ("a[.]/x", "a./x", true),
                ("[.]/x", "x", false),
            ] {
                assert_eq!(
                    GlobRule::new(pattern, anchor).unwrap().matches(path, false),
                    expected,
                    "pattern={pattern:?}, path={path:?}, anchor={anchor}"
                );
            }
            let rule = GlobRule::new("a[.]/x", anchor).unwrap();
            assert!(rule.below("a."));
            assert!(!rule.below("a"));
        }
    }

    #[test]
    fn posix_classes_are_refused_inside_classes_without_rejecting_literal_brackets() {
        for anchor in [false, true] {
            for pattern in [
                "[a[:digit:]]",
                "[!a[:digit:]]",
                "[^a[:digit:]]",
                "{keep,[a[:digit:]]}",
            ] {
                let error = GlobRule::new(pattern, anchor)
                    .err()
                    .expect("unsupported POSIX class");
                assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
                assert_eq!(error.to_string(), "unsupported glob pattern");
            }
            for (pattern, path, expected) in [
                ("[a:]", "a", true),
                ("[a:]", ":", true),
                ("[a:]", "x", false),
                ("[[]", "[", true),
                ("[[]", "a", false),
                ("[[][:digit:]", "[g", true),
                ("[[][:digit:]", "[1", false),
            ] {
                assert_eq!(
                    GlobRule::new(pattern, anchor).unwrap().matches(path, false),
                    expected,
                    "pattern={pattern:?}, path={path:?}, anchor={anchor}"
                );
            }
        }
    }

    #[test]
    fn explicit_dot_in_one_segment_does_not_admit_other_hidden_segments() {
        for anchor in [false, true] {
            for (pattern, path, expected) in [
                (".hidden/*", ".hidden/visible.txt", true),
                (".hidden/*", ".hidden/.secret", false),
                ("*/.wanted", "visible/.wanted", true),
                ("*/.wanted", ".hidden/.wanted", false),
                ("**/.wanted", "visible/nested/.wanted", true),
                ("**/.wanted", "visible/.hidden/.wanted", false),
                (".hidden/.*", ".hidden/.wanted", true),
            ] {
                let rule = GlobRule::new(pattern, anchor).unwrap();
                assert_eq!(
                    rule.matches(path, false),
                    expected,
                    "pattern={pattern:?}, path={path:?}, anchor={anchor}"
                );
            }
        }
    }

    #[test]
    fn globstar_aligns_only_visible_components_around_explicit_hidden_names() {
        for anchor in [false, true] {
            for (pattern, path, expected) in [
                ("**/.hidden/**/.wanted", ".hidden/.wanted", true),
                (
                    "**/.hidden/**/.wanted",
                    "visible/.hidden/nested/.wanted",
                    true,
                ),
                (
                    "**/.hidden/**/.wanted",
                    "visible/.hidden/.nested/.wanted",
                    false,
                ),
                ("**/.hidden/**/.wanted", ".other/.hidden/.wanted", false),
                (
                    "**/.hidden/**/.wanted",
                    "visible/.hidden/nested/.other/.wanted",
                    false,
                ),
                ("**/**/.wanted", "visible/deep/.wanted", true),
                ("**/**/.wanted", "visible/.hidden/.wanted", false),
                ("[.]hidden/**/.wanted", ".hidden/.wanted", true),
                ("[.]hidden/**/.wanted", ".hidden/nested/.wanted", true),
                ("[.]hidden/**/.wanted", ".hidden/.nested/.wanted", false),
                ("[!a]*", ".hidden", false),
                ("[^a]*", ".hidden", false),
            ] {
                assert_eq!(
                    GlobRule::new(pattern, anchor).unwrap().matches(path, false),
                    expected,
                    "pattern={pattern:?}, path={path:?}, anchor={anchor}"
                );
            }
        }
    }

    #[test]
    fn brace_expansion_preserves_nested_empty_and_unicode_choices() {
        let rule = GlobRule::new("{docs,{src,🧭},}/-{a,}.txt", true).unwrap();
        for path in ["docs/-a.txt", "src/-.txt", "🧭/-a.txt"] {
            assert!(rule.matches(path, false), "path={path:?}");
        }
        for path in [
            "-a.txt",
            "other/-a.txt",
            "docs/-b.txt",
            "docs/.hidden/-a.txt",
        ] {
            assert!(!rule.matches(path, false), "path={path:?}");
        }
    }

    #[test]
    fn pattern_limits_accept_boundaries_and_reject_the_next_value() {
        assert!(GlobRule::new(&"a".repeat(4096), true).is_ok());
        assert!(GlobRule::new(&"é".repeat(2048), true).is_ok());
        for pattern in ["a".repeat(4097), format!("{}a", "é".repeat(2048))] {
            let error = GlobRule::new(&pattern, true).err().unwrap();
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
            assert_eq!(error.to_string(), "unsupported glob pattern");
        }
        let alternatives = |count: usize| format!("{{{}}}", vec!["a"; count].join(","));
        assert!(GlobRule::new(&alternatives(64), true).is_ok());
        let error = GlobRule::new(&alternatives(65), true).err().unwrap();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert_eq!(
            error.to_string(),
            "glob pattern expands past 64 alternatives"
        );
    }

    #[test]
    fn unsupported_syntax_is_rejected_at_the_rule_boundary() {
        for pattern in [
            "{1..3}",
            "@(a|b)",
            "+(a|b)",
            "?(a|b)",
            "!(a|b)",
            "*(a|b)",
            "[[:alpha:]]",
            "[a/@(private)/**",
        ] {
            assert!(GlobRule::new(pattern, true).is_err(), "pattern={pattern:?}");
        }
        for pattern in ["[!(]*", "[0?(].txt", "[a/[(]"] {
            assert!(GlobRule::new(pattern, true).is_ok(), "pattern={pattern:?}");
        }
    }

    #[test]
    fn leading_literal_closing_brackets_keep_question_and_parenthesis_inside_classes() {
        // Independent Node fs.glob controls select ], ?, ( for the positive
        // class and only x for either negation in this five-file inventory.
        for anchor in [false, true] {
            for (pattern, selected) in [
                ("[]?(]", [true, true, true, false, false]),
                ("[!]?(]", [false, false, false, true, false]),
                ("[^]?(]", [false, false, false, true, false]),
            ] {
                let rule = GlobRule::new(pattern, anchor).unwrap();
                for (path, expected) in ["]", "?", "(", "x", "keep.txt"].into_iter().zip(selected) {
                    assert_eq!(
                        rule.matches(path, false),
                        expected,
                        "pattern={pattern:?}, path={path:?}, anchor={anchor}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_real_class_end_and_a_slash_end_class_protection_before_extglobs() {
        for pattern in ["[a]?(private)", "[]?(]@(private)", "[a/@(private)/**"] {
            for anchor in [false, true] {
                let error = GlobRule::new(pattern, anchor).err().unwrap();
                assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
                assert_eq!(error.to_string(), "unsupported glob pattern");
            }
        }
    }

    #[test]
    fn unsupported_extglobs_in_brace_alternatives_cannot_hide_in_another_class() {
        for pattern in [
            "{[a,@(private)}",
            "{keep,{[a,@(private)}}",
            "{[a],@(private)}",
        ] {
            for anchor in [false, true] {
                let error = GlobRule::new(pattern, anchor).err().unwrap();
                assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
                assert_eq!(error.to_string(), "unsupported glob pattern");
            }
        }
        // An unclosed literal class in one alternative is legal and must not
        // reject an ordinary sibling merely because validation moved inward.
        for anchor in [false, true] {
            let rule = GlobRule::new("{[a,keep}", anchor).unwrap();
            assert!(rule.matches("[a", false));
            assert!(rule.matches("keep", false));
            assert!(!rule.matches("private", false));
        }
    }

    #[test]
    fn root_and_directory_only_rules_distinguish_selector_from_exclusion() {
        for pattern in ["", ".", "[.]"] {
            let rule = GlobRule::new(pattern, true).unwrap();
            assert!(rule.includes_root(), "pattern={pattern:?}");
            assert!(rule.matches("", true), "pattern={pattern:?}");
            assert!(!rule.below(""), "pattern={pattern:?}");
        }
        let selected = GlobRule::new(".hidden/**", true).unwrap();
        let excluded = GlobRule::new(".hidden/**", false).unwrap();
        assert!(selected.matches(".hidden", true));
        assert!(!excluded.matches(".hidden", true));
        assert!(selected.matches(".hidden/visible.txt", false));
        assert!(excluded.matches(".hidden/visible.txt", false));

        let directories = GlobRule::new("docs/", true).unwrap();
        assert!(directories.matches("docs", true));
        assert!(!directories.matches("docs", false));
        assert!(directories.below(""));
        assert!(!directories.includes_root());
    }

    #[test]
    fn trailing_globstar_anchors_distinguish_files_directories_and_repeated_segments() {
        // The public adapter contract deliberately differs from Node here:
        // every trailing-globstar exclusion retains its own anchor, regardless
        // of the selector, while still removing actual descendants.
        for (pattern, path, directory, selected, excluded) in [
            ("deep/**", "deep", false, true, false),
            ("deep/**", "deep", true, true, false),
            ("deep/**", "deep/leaf.txt", false, true, true),
            ("deep/**/deep/**", "deep", true, false, false),
            ("deep/**/deep/**", "deep/deep", true, true, false),
            ("deep/**/deep/**", "deep/deep/nested.txt", false, true, true),
            (".hidden/**", ".hidden", false, true, false),
            (".hidden/**", ".hidden", true, true, false),
            (".hidden/**", ".hidden/secret.txt", false, true, true),
            ("**/**", "visible", true, true, true),
            ("**/**", ".hidden", true, false, false),
            ("**/**", ".hidden/secret.txt", false, false, false),
        ] {
            assert_eq!(
                GlobRule::new(pattern, true)
                    .unwrap()
                    .matches(path, directory),
                selected,
                "selector pattern={pattern:?}, path={path:?}, directory={directory}"
            );
            assert_eq!(
                GlobRule::new(pattern, false)
                    .unwrap()
                    .matches(path, directory),
                excluded,
                "exclusion pattern={pattern:?}, path={path:?}, directory={directory}"
            );
        }
    }

    #[test]
    fn repeated_trailing_globstars_select_their_anchors_but_exclusions_keep_them() {
        for (pattern, path, directory, selected, excluded) in [
            ("deep/**/**", "deep", true, true, false),
            ("deep/**/**", "deep", false, true, false),
            ("deep.txt/**/**", "deep.txt", false, true, false),
            ("d*/**/**", "deep", true, true, false),
            ("t*.txt/**/**", "top.txt", false, false, false),
            ("deep/**/**/**", "deep", true, true, false),
            ("deep/**/**", "deep/visible.txt", false, true, true),
            ("deep/**/**", "deep/nested", true, true, true),
            ("deep/**/**", "deep/.secret", false, false, false),
            ("deep/**/**", "deep/nested/.secret", false, false, false),
            (".hidden/**/**", ".hidden", true, true, false),
            (".hidden/**/**", ".hidden", false, true, false),
            (".hidden/**/**/**", ".hidden", true, true, false),
            (".hidden/**/**", ".hidden/visible.txt", false, true, true),
            (".hidden/**/**", ".hidden/.secret", false, false, false),
            ("{deep,.hidden}/**/**", "deep", true, true, false),
            ("{deep,.hidden}/**/**", ".hidden", true, true, false),
            (
                "{deep,.hidden}/**/**",
                ".hidden/visible.txt",
                false,
                true,
                true,
            ),
            ("**/**/**", "", true, true, false),
            ("**/**/**/**", "", true, true, false),
            ("**/**/**", "visible", true, true, true),
            ("**/**/**", "visible/file.txt", false, true, true),
            ("**/**/**", ".hidden", true, false, false),
            ("**/**/**", "visible/.secret", false, false, false),
        ] {
            for (anchor, expected) in [(true, selected), (false, excluded)] {
                assert_eq!(
                    GlobRule::new(pattern, anchor)
                        .unwrap()
                        .matches(path, directory),
                    expected,
                    "pattern={pattern:?}, path={path:?}, directory={directory}, anchor={anchor}"
                );
            }
        }
    }

    #[test]
    fn unmatched_closing_brackets_do_not_disable_later_classes_and_unclosed_classes_are_literal() {
        for anchor in [false, true] {
            let class = GlobRule::new("]prefix/[ab].txt", anchor).unwrap();
            assert!(class.matches("]prefix/a.txt", false));
            assert!(class.matches("]prefix/b.txt", false));
            assert!(!class.matches("]prefix/c.txt", false));
            assert!(class.below("]prefix"));

            let literal = GlobRule::new("unclosed[.txt", anchor).unwrap();
            assert!(literal.matches("unclosed[.txt", false));
            assert!(!literal.matches("unclosedx.txt", false));

            let separated = GlobRule::new("[a/[(]", anchor).unwrap();
            assert!(separated.matches("[a/(", false));
            assert!(!separated.matches("[a/private", false));
        }
    }

    #[test]
    fn traversal_prefixes_respect_hidden_components_and_remaining_depth() {
        for (pattern, prefix, expected) in [
            ("**/*.txt", "visible", true),
            ("**/*.txt", ".hidden", false),
            ("*.txt", ".hidden", false),
            (".hidden/*.txt", ".hidden", true),
            ("[.]hidden/*.txt", ".hidden", true),
            ("**/.hidden/*.txt", "visible/.hidden", true),
            ("**/.hidden/*.txt", "visible/.other", false),
            ("**/.hidden/*.txt", "visible/.hidden/.nested", false),
            ("src/*.txt", "src", true),
            ("src/*.txt", "src/deep", false),
            ("src/**", "src", true),
            ("src/**", "src/.hidden", false),
        ] {
            assert_eq!(
                GlobRule::new(pattern, true).unwrap().below(prefix),
                expected,
                "pattern={pattern:?}, prefix={prefix:?}"
            );
        }
    }

    #[test]
    fn slash_inside_a_character_class_is_a_segment_separator() {
        let rule = GlobRule::new("[a/]*/**", true).unwrap();
        assert!(rule.matches("[a/]/selected.txt", false));
        assert!(rule.matches("[a/]foo/selected.txt", false));
        assert!(!rule.matches("a", true));
        assert!(!rule.matches("a/selected.txt", false));
        assert!(rule.below("[a"));
        assert!(!rule.below("a"));
    }

    #[test]
    fn relative_patterns_follow_selector_and_exclusion_normalization() {
        for (pattern, base, exclusion, expected) in [
            ("/repo/src/*.txt", "/repo", false, "src/*.txt"),
            ("/repo", "/repo", false, ""),
            ("/repo/src/*.txt", "/repo/", false, "src/*.txt"),
            ("/repo/src/*.txt", "/", false, "repo/src/*.txt"),
            (
                "/repository/src/*.txt",
                "/repo",
                false,
                "/repository/src/*.txt",
            ),
            (
                "/repository/src/*.txt",
                "/repo",
                true,
                "/repository/src/*.txt",
            ),
            ("./src/*.txt", "/repo", false, "src/*.txt"),
            ("src\\*.txt", "/repo", false, "\0"),
            ("/repo/src\\*.txt", "/repo", false, "src*.txt"),
            ("src\\*.txt", "/repo", true, "src*.txt"),
            ("/other/*.txt", "/repo", true, "/other/*.txt"),
            ("/repo/", "/repo", false, ""),
            ("/repo", "/repo/", false, ""),
            ("/repo/", "/repo/", false, ""),
            ("/repo//", "/repo", false, ""),
            ("/repo", "/repo//", false, ""),
            ("/repo/", "/repo", true, ""),
            ("/repo", "/repo/", true, ""),
            ("/repo/src/", "/repo/", false, "src/"),
            ("/repository", "/repo/", false, "/repository"),
            ("/", "/", false, ""),
            ("/*.txt", "/", false, "*.txt"),
            ("src/*.txt", "/", false, "src/*.txt"),
        ] {
            assert_eq!(relative_pattern(pattern, base, exclusion), expected);
        }
    }
}
