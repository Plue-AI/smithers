// Package modelprice is the single checked-in price table for every model
// Smithers runs on platform keys. Every metered model call computes its cost
// here; nothing else in the tree holds a price.
//
// Prices are list prices per million tokens in micro-dollars (1 USD =
// 1_000_000). A model missing from the table, or whose price for long
// prompts is not declared, is refused by the metering point, never
// estimated: an unpriced model is an unmetered bill.
package modelprice

import (
	"errors"
	"math/big"
	"strings"
	"time"
)

// Rates is one rate card. Every class a provider can report is priced; a
// provider without a cheaper cache class is entered at its input rate.
type Rates struct {
	// InputPerMTok / OutputPerMTok are micro-dollars per million tokens.
	InputPerMTok  int64
	OutputPerMTok int64
	// CacheReadPerMTok / CacheWritePerMTok apply to prompt-cache tokens the
	// provider reports separately from InputPerMTok. CacheWrite1hPerMTok
	// prices writes to Anthropic's 1-hour cache.
	CacheReadPerMTok    int64
	CacheWritePerMTok   int64
	CacheWrite1hPerMTok int64
}

// ContextPricing declares how a model's price depends on prompt size. The
// zero value is unknown, and a model with unknown context pricing is refused.
type ContextPricing int

const (
	contextUnknown ContextPricing = iota
	// ContextFlat is one rate card at every prompt size the model accepts.
	ContextFlat
	// ContextTiered charges the whole call at LongContext once the prompt
	// reaches LongContextFrom input tokens.
	ContextTiered
)

// Price is one model's rate card.
type Price struct {
	// Provider is the upstream the model is served by (anthropic, openai,
	// cerebras, openrouter, vercel).
	Provider string
	Rates
	Context ContextPricing
	// LongContextFrom is the prompt size, in input tokens (uncached, cache
	// read and cache write together), from which LongContext prices every
	// token of the call. Only for ContextTiered.
	LongContextFrom int64
	LongContext     Rates
	// FlatPerCall is charged once per call for endpoints that report no
	// token usage (the Jev evaluation model).
	FlatPerCall int64
	// Next replaces this price from NextFrom on: a published, dated change
	// such as the end of an introductory price.
	NextFrom time.Time
	Next     *Price
}

// Usage is what a provider reported for one call. CacheWriteTokens counts
// every cache write; CacheWrite1hTokens is the part of it written to the
// 1-hour cache, priced at CacheWrite1hPerMTok.
type Usage struct {
	InputTokens        int64
	OutputTokens       int64
	CacheReadTokens    int64
	CacheWriteTokens   int64
	CacheWrite1hTokens int64
}

// PromptTokens is every input token of the call, whatever its cache class:
// the size providers compare with a long-context threshold.
func (u Usage) PromptTokens() int64 {
	return u.InputTokens + u.CacheReadTokens + u.CacheWriteTokens
}

// usd converts a dollar amount to micro-dollars: usd(2.5) == 2_500_000.
func usd(dollars float64) int64 { return int64(dollars*1_000_000 + 0.5) }

// OpenAILongContextFrom is where OpenAI's long-context rates start. OpenAI
// states ">272K input tokens"; OpenRouter lists the same rates from
// min_prompt_tokens 272000. The premium is charged from 272,000 so the
// boundary token itself can never be under-charged.
const OpenAILongContextFrom = 272_000

// Table is keyed by the model id the caller sends on the wire.
//
// Sources, read 2026-09-25:
//   - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
//     ("Long context pricing": Claude 4.6 and later include the 1M context
//     window at standard pricing) and
//     https://platform.claude.com/docs/en/build-with-claude/context-windows
//     (Sonnet 4.5 and Haiku 4.5 have a 200k window; the proxy refuses the
//     context-1m beta, and OpenRouter's 1M Sonnet 4.5 is tiered). Cache write 1.25x input (5-minute) or 2x input
//     (1-hour), cache read 0.1x (0.05x Opus 5.5, 0.025x Fable 5.1).
//   - OpenAI: https://developers.openai.com/api/docs/pricing and each
//     https://developers.openai.com/api/docs/models/<id> page: prompts over
//     272K input tokens are priced at 2x input and cache rates and 1.5x
//     output for the full request. GPT-5.6 and later bill cache writes at
//     1.25x input; earlier models add no cache-write charge.
//   - Cerebras: https://www.cerebras.ai/pricing (developer tier; context
//     131k/128k per https://inference-docs.cerebras.ai/models/overview).
//     No cache price is published, so cached tokens are charged as input.
//   - OpenRouter: https://openrouter.ai/api/v1/models.
//   - Google: https://ai.google.dev/gemini-api/docs/pricing (paid tier).
//     No cache-write price is published, so cache writes are charged as
//     input.
var Table = map[string]Price{
	"claude-fable-5-1":  anthropic(10, 50, 0.025),
	"claude-fable-5":    anthropic(10, 50, 0.1),
	"claude-opus-5-5":   anthropic(4, 20, 0.05),
	"claude-opus-5":     anthropic(5, 25, 0.1),
	"claude-opus-4-8":   anthropic(5, 25, 0.1),
	"claude-opus-4-7":   anthropic(5, 25, 0.1),
	"claude-opus-4-6":   anthropic(5, 25, 0.1),
	"claude-sonnet-5":   anthropic(2, 10, 0.1),
	"claude-sonnet-4-6": anthropic(3, 15, 0.1),
	// 200k context window on Anthropic, where the 1M beta is refused; 1M on
	// OpenRouter, which charges 2x input and cache and 1.5x output from
	// 200,000 prompt tokens (https://openrouter.ai/api/v1/models).
	"claude-sonnet-4-5": anthropicTiered(3, 15, 200_000),
	"claude-haiku-4-5":  anthropic(1, 5, 0.1),

	"gpt-6-astra": openaiTiered(10, 1, 12.5, 50),
	"gpt-6-sol":   openaiTiered(2, 0.2, 2.5, 10),
	"gpt-6-luna":  openaiTiered(0.1, 0.01, 0.125, 0.5),
	// Promotional through at least 2026-11-21; re-check before then.
	"gpt-5.6-sol":   openaiTiered(4, 0.4, 5, 20),
	"gpt-5.6-terra": openaiTiered(2, 0.2, 2.5, 12),
	"gpt-5.6-luna":  openaiTiered(0.2, 0.02, 0.25, 1.2),
	"gpt-5.5":       openaiTiered(5, 0.5, 5, 30),
	// 128k context window, one rate card.
	"gpt-4o": {Provider: "openai", Context: ContextFlat, Rates: Rates{InputPerMTok: usd(2.5), OutputPerMTok: usd(10), CacheReadPerMTok: usd(1.25), CacheWritePerMTok: usd(2.5), CacheWrite1hPerMTok: usd(2.5)}},

	"gpt-oss-120b": flat("cerebras", 0.35, 0.75),
	"qwen-3.8-27b": flat("cerebras", 0.99, 1.49),
	// OpenRouter lists 0.15/0.60 (cache read 0.075); the ceiling sent with
	// the call is this row, so no routed provider costs more.
	"gpt-oss-120b@openrouter": flat("openrouter", 0.35, 0.75),

	// Introductory through 2026-12-31, doubled from 2027-01-01.
	"gemini-3.8-flash": dated(flatCached("google", 0.75, 3.75, 0.075), time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), flatCached("google", 1.50, 7.50, 0.15)),

	// Vercel AI Gateway evaluation model: no token usage on the wire, flat
	// per call (VERIFY against the gateway invoice).
	"typesafe-ai/jev": {Provider: "vercel", Context: ContextFlat, FlatPerCall: usd(0.002)},
}

func anthropic(in, out, cacheRead float64) Price {
	return Price{Provider: "anthropic", Context: ContextFlat, Rates: Rates{
		InputPerMTok:        usd(in),
		OutputPerMTok:       usd(out),
		CacheReadPerMTok:    usd(in * cacheRead),
		CacheWritePerMTok:   usd(in * 1.25),
		CacheWrite1hPerMTok: usd(in * 2),
	}}
}

// anthropicTiered adds Anthropic's former long-context premium: 2x input and
// cache rates and 1.5x output for the whole call from the threshold.
func anthropicTiered(in, out float64, from int64) Price {
	price := anthropic(in, out, 0.1)
	price.Context, price.LongContextFrom = ContextTiered, from
	price.LongContext = Rates{InputPerMTok: usd(in * 2), OutputPerMTok: usd(out * 1.5), CacheReadPerMTok: usd(in * 0.2), CacheWritePerMTok: usd(in * 2.5), CacheWrite1hPerMTok: usd(in * 4)}
	return price
}

// openaiTiered is an OpenAI rate card with the long-context premium: 2x
// input and cache rates and 1.5x output from OpenAILongContextFrom.
func openaiTiered(in, cacheRead, cacheWrite, out float64) Price {
	return Price{
		Provider:        "openai",
		Context:         ContextTiered,
		Rates:           Rates{InputPerMTok: usd(in), OutputPerMTok: usd(out), CacheReadPerMTok: usd(cacheRead), CacheWritePerMTok: usd(cacheWrite), CacheWrite1hPerMTok: usd(cacheWrite)},
		LongContextFrom: OpenAILongContextFrom,
		LongContext:     Rates{InputPerMTok: usd(in * 2), OutputPerMTok: usd(out * 1.5), CacheReadPerMTok: usd(cacheRead * 2), CacheWritePerMTok: usd(cacheWrite * 2), CacheWrite1hPerMTok: usd(cacheWrite * 2)},
	}
}

// flat is one rate card with no published cache discount.
func flat(provider string, in, out float64) Price {
	return Price{Provider: provider, Context: ContextFlat, Rates: Rates{InputPerMTok: usd(in), OutputPerMTok: usd(out), CacheReadPerMTok: usd(in), CacheWritePerMTok: usd(in), CacheWrite1hPerMTok: usd(in)}}
}

// flatCached is one rate card with a published cache-read discount.
func flatCached(provider string, in, out, cacheRead float64) Price {
	price := flat(provider, in, out)
	price.CacheReadPerMTok = usd(cacheRead)
	return price
}

func dated(current Price, from time.Time, next Price) Price {
	current.NextFrom, current.Next = from, &next
	return current
}

// Lookup returns the price in effect now for a model id. Provider-prefixed
// ids such as "anthropic/claude-sonnet-5" (OpenRouter and the Vercel gateway)
// resolve to the bare id. A model whose context pricing is unknown is not
// found.
func Lookup(model string) (Price, bool) { return LookupAt(model, time.Now()) }

// LookupAt returns the price in effect at a given time.
func LookupAt(model string, at time.Time) (Price, bool) {
	model = strings.TrimSpace(model)
	price, ok := Table[model]
	if !ok {
		if i := strings.LastIndex(model, "/"); i >= 0 {
			price, ok = Table[model[i+1:]]
		}
	}
	if !ok {
		return Price{}, false
	}
	for price.Next != nil && !at.Before(price.NextFrom) {
		price = *price.Next
	}
	if !price.known() {
		return Price{}, false
	}
	return price, true
}

func (p Price) known() bool {
	switch p.Context {
	case ContextFlat:
		return true
	case ContextTiered:
		return p.LongContextFrom > 0
	}
	return false
}

// RatesFor is the rate card that prices a call with this many prompt tokens.
func (p Price) RatesFor(promptTokens int64) Rates {
	if p.Context == ContextTiered && promptTokens >= p.LongContextFrom {
		return p.LongContext
	}
	return p.Rates
}

// Maximum is the dearest usage a call can report when its prompt is at most
// promptTokens and its output at most outputTokens: every prompt token is
// placed in the dearest input class of the rate card that prompt size
// selects. Any split the provider reports costs no more than this, provided
// no long-context rate is below its standard rate (checked by the tests).
func (p Price) Maximum(promptTokens, outputTokens int64) Usage {
	rates := p.RatesFor(promptTokens)
	usage := Usage{OutputTokens: outputTokens}
	switch max(rates.InputPerMTok, rates.CacheReadPerMTok, rates.CacheWritePerMTok, rates.CacheWrite1hPerMTok) {
	case rates.CacheWritePerMTok:
		usage.CacheWriteTokens = promptTokens
	case rates.CacheWrite1hPerMTok:
		usage.CacheWriteTokens, usage.CacheWrite1hTokens = promptTokens, promptTokens
	case rates.CacheReadPerMTok:
		usage.CacheReadTokens = promptTokens
	default:
		usage.InputTokens = promptTokens
	}
	return usage
}

// CostNanos computes a provider charge in integer USD nanos. The prompt size
// selects the rate card; the sum is rounded upward once, preserving sub-cent
// value without floats.
func CostNanos(price Price, usage Usage) (int64, error) {
	if usage.InputTokens < 0 || usage.OutputTokens < 0 || usage.CacheReadTokens < 0 || usage.CacheWriteTokens < 0 || usage.CacheWrite1hTokens < 0 {
		return 0, errors.New("negative model usage")
	}
	if usage.CacheWrite1hTokens > usage.CacheWriteTokens {
		return 0, errors.New("1-hour cache writes exceed all cache writes")
	}
	if !price.known() {
		return 0, errors.New("model context pricing is unknown")
	}
	if price.FlatPerCall < 0 {
		return 0, errors.New("negative model price")
	}
	prompt := new(big.Int).Add(big.NewInt(usage.InputTokens), big.NewInt(usage.CacheReadTokens))
	prompt.Add(prompt, big.NewInt(usage.CacheWriteTokens))
	rates := price.Rates
	if price.Context == ContextTiered && (!prompt.IsInt64() || prompt.Int64() >= price.LongContextFrom) {
		rates = price.LongContext
	}
	numerator := new(big.Int)
	for _, part := range [][2]int64{{usage.InputTokens, rates.InputPerMTok}, {usage.OutputTokens, rates.OutputPerMTok}, {usage.CacheReadTokens, rates.CacheReadPerMTok}, {usage.CacheWriteTokens - usage.CacheWrite1hTokens, rates.CacheWritePerMTok}, {usage.CacheWrite1hTokens, rates.CacheWrite1hPerMTok}} {
		if part[1] < 0 {
			return 0, errors.New("negative model price")
		}
		numerator.Add(numerator, new(big.Int).Mul(big.NewInt(part[0]), big.NewInt(part[1])))
	}
	numerator.Mul(numerator, big.NewInt(1000))
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(numerator, big.NewInt(1_000_000), remainder)
	if remainder.Sign() > 0 {
		quotient.Add(quotient, big.NewInt(1))
	}
	quotient.Add(quotient, new(big.Int).Mul(big.NewInt(price.FlatPerCall), big.NewInt(1000)))
	if !quotient.IsInt64() {
		return 0, errors.New("model cost overflow")
	}
	return quotient.Int64(), nil
}
