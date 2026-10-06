use smithers_machined::{hooks::Actor, moved_off::*};
fn position(present: bool, descends: bool, id: u8) -> Position {
    Position {
        present,
        descends,
        working_copy: [id; 20],
    }
}
#[test]
fn metadata_predicate_table() {
    let history = [
        position(true, false, 8),
        position(true, true, 7),
        position(true, true, 6),
    ];
    for (name, present, descends, moved) in [
        ("git checkout main", true, false, true),
        ("git switch from main", true, false, true),
        ("jj edit main identical tree", true, false, true),
        ("jj new main", true, false, true),
        ("jj abandon item", false, false, true),
        ("missing change", false, true, true),
        ("git commit on item", true, true, false),
        ("jj new on item", true, true, false),
        ("rebase retains change id", true, true, false),
        ("git branch same commit", true, true, false),
    ] {
        let fact = detect(
            "T2",
            Actor::Session(4),
            &position(present, descends, 9),
            &history,
            None,
        )
        .unwrap();
        assert_eq!(fact.is_some(), moved, "{name}");
        if let Some(fact) = fact {
            assert_eq!(fact.pre_move, [7; 20], "{name}");
        }
    }
}
#[test]
fn redelivery_return_scratch_and_missing_history() {
    let fact = Fact {
        by: Actor::Session(4),
        item: "T2".into(),
        pre_move: [7; 20],
    };
    assert_eq!(
        detect(
            "T2",
            Actor::Outside,
            &position(false, false, 9),
            &[],
            Some(&fact)
        )
        .unwrap(),
        Some(fact.clone())
    );
    assert!(detect(
        "T2",
        Actor::Outside,
        &position(true, true, 7),
        &[],
        Some(&fact)
    )
    .unwrap()
    .is_none());
    assert!(
        detect("", Actor::Outside, &position(false, false, 9), &[], None)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        detect(
            "T3",
            Actor::Outside,
            &position(false, false, 9),
            &[position(true, true, 0)],
            Some(&fact)
        )
        .unwrap_err()
        .code,
        3
    );
    assert_eq!(
        capture_target(Some(&fact), Some([6; 20]), [9; 20]).unwrap(),
        [6; 20]
    );
    assert_eq!(capture_target(None, None, [9; 20]).unwrap(), [9; 20]);
    assert!(capture_target(Some(&fact), None, [9; 20]).is_err());
    assert_eq!(
        guard_agent(Some(&fact), &Actor::Run("coding".into()))
            .unwrap_err()
            .code,
        10
    );
    assert!(guard_agent(Some(&fact), &Actor::Session(4)).is_ok());
    assert!(guard_agent(None, &Actor::Run("coding".into())).is_ok());
}
