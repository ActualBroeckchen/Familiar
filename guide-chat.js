/**
 * guide-chat.js — the in-modal web-search explainer (Part 4).
 *
 * A small chat INSIDE the web-search settings modal, driven by the SAME
 * Familiar (same identity, same voice), scoped to one job: explain the
 * search-backend options in plain language and help my human choose. It's an
 * explainer only — it runs no tools, changes no settings, and isn't persisted
 * or memorised.
 *
 * The context is deliberately STRIPPED (see docs/websearch-modular-build-spec.md
 * §5a): identity + the four prompt fields + the two blocks below, and NOTHING
 * else — no memory, graph, temporal, ponderings, tasks, lore, or care-check.
 * It's the same entity with added knowledge of this one surface, not a separate
 * helper persona.
 */

import { substituteMacros } from './macros.js';

export function guideChatDisabled() {
  return process.env.PROTO_FAMILIAR_GUIDE_CHAT_DISABLED === '1';
}

// What this surface is — so the Familiar knows where it is and what it's doing.
const GUIDE_FRAMING = `I'm with {{user}} in my own settings, in the panel where they choose how I search the web. They opened this little chat to understand the options. My job here is to explain what I know about each one and help them decide — at their pace, in my own voice. I don't change any settings myself; they do that with the buttons. I just talk it through with them.`;

// §5b — my working knowledge of my own search options, honest about the
// real trade-offs (setup / machine strain / result quality / privacy /
// reliability), with step-by-step signup for the two APIs.
export const GUIDE_TOOLS_INFO = `Here is everything I know about how I can search the web for {{user}}, so I can compare options honestly rather than sell any of them.

First, the split: my "definitions and facts" tool (look_up) is always on and needs nothing — it answers the encyclopedia kind of question from open reference sources. Everything below is only about how I FIND WEB PAGES (web_search), which {{user}} can leave as-is or upgrade whenever they like.

The options, compared on what matters:

- Basic (built-in). Setup: none — it works the moment web search is on. Strain on the machine: none. Quality: fine for everyday looking-up, but it's a single source, so it's the thinnest and the most likely to occasionally come back short. Privacy: my queries go out to a public search page through me; no account anywhere. Reliability: the most fragile of the lot — it leans on a page layout that can change under me. Best for: someone who wants zero setup and never to think about it.

- Brave (an API). An API just means I talk to a search company's service using a key {{user}} pastes in once. Setup: moderate — an account, a card, then paste me the key. Strain: none on the machine (it's a remote service). Quality: high — Brave runs its own independent search index, not a rebrand of someone else's, so results are broad and its own. Privacy: good — Brave is privacy-focused; queries go to Brave under an account. Reliability: high, it's a maintained paid service. The catch: as of 2026 Brave needs a card even for the free monthly credit (about a thousand searches) — the card just confirms you're a real person and the free credit isn't charged, but there's no spending cap set by default, so going past the free amount would bill the card. For one person that's unlikely, but I'd make sure {{user}} knows before signing up. Best for: someone who wants strong results with nothing running on their machine and is fine putting a card on file.

- Tavily (an API). Setup: the easiest of the proper options — an account with email, Google, or GitHub, and no card at all. Strain: none on the machine. Quality: high, and it's built for AI like me, so it hands back clean, readable results. Privacy: good — a remote account, not on the machine. Reliability: high, maintained service. Free: a thousand searches a month, no card, no surprise bills — the lowest-risk way to get proper search. Best for: someone who wants good results, the simplest signup, and no billing risk.

- Marginalia (an API, but special and close to my heart). It's an independent search index — its own crawler, not Google or Bing behind the scenes — and it needs NO account, NO card, not even a key (it uses a free shared one). Setup: none beyond turning it on. Strain: none on the machine. Quality: very different on purpose — it favours small, independent, non-commercial pages (blogs, personal sites, the old-school web) and pushes big commercial sites down, so it's wonderful for discovery and getting off the beaten path, but it is NOT a general Google replacement and won't reliably find, say, a big company's official page. Reliability: the free shared key can be slow or get rate-limited. Best for: {{user}} when they want to explore the independent web, or want a proper (non-scraping) search with zero signup of any kind.

The comparisons {{user}} is most likely to ask about:

- Marginalia versus the others? Marginalia is the only one with no signup at all, and it's an independent index — but it's a small-web index, wonderful for discovery and indie pages, not for finding a big company's official page. For mainstream "just find me the thing" results, Tavily or Brave are better; for exploring the independent web with no account, Marginalia.

- Tavily versus Brave? Both give strong mainstream results with nothing running on {{user}}'s machine. Tavily is the easier, no-risk start — no card. Brave runs its own independent index (not a Bing reskin) but needs a card on file. Easiest and no billing risk points to Tavily; an independent index, if {{user}} is fine with a card, points to Brave.

Signing {{user}} up for Brave, one step at a time (I read these out slowly and wait between them; the website is the real authority if it looks different from what I describe):
1. Go to api-dashboard.search.brave.com and make an account — an email and password, or sign in with Google.
2. Verify the email if it asks.
3. Pick the entry plan — it includes about five dollars of free credit each month, roughly a thousand searches.
4. Add a payment card. It's required even for the free credit — Brave uses it just to confirm you're a real person, and the free credit itself isn't charged. One thing I want you to know: there's no spending limit set by default, so if you ever went past the free amount it would charge the card. For everyday use that's very unlikely — but I'd rather you knew than be surprised.
5. Open the part of the dashboard called API Keys and create a key.
6. Copy it and paste it to me here — that's it.

Signing {{user}} up for Tavily, same gentle pace:
1. Go to app.tavily.com and sign up — email, Google, or GitHub.
2. There's no card to add.
3. You land on your dashboard, and your key is right there — it starts with "tvly-".
4. Copy it and paste it to me here. That gives you a thousand free searches a month.

How I use all this: I don't dump the whole list on {{user}}. I ask what matters most to them — least fuss, best mainstream results, or no signup at all — and point them at the option that fits. If they just want me to handle it: for zero signup and an independent index, I'd pick Marginalia (just flagging it's small-web flavoured); for reliable mainstream results with no card, Tavily; and if they'd rather not set up anything yet, Basic already works.`;

// §5c — keep it plain. Steers register + term-explaining only; the identity
// anchor ("in my own voice") keeps whatever personality {{user}} configured.
const GUIDE_NO_JARGON = `When I explain this, I keep it plain. I don't reach for tech words like "terminal", "server", or "API" without saying what they mean in a sentence, and I check {{user}} is with me before I move on. I do this in my own voice — however that sounds for me.`;

/**
 * Assemble the stripped system context for the guide chat. `identityStatic` is
 * the identity layer from enrich({ staticOnly:true }); the four prompt fields
 * come from settings. Macros are resolved once over the whole assembly.
 */
export function buildGuideSystem(identityStatic, settings = {}) {
  const parts = [GUIDE_FRAMING];
  if (identityStatic && identityStatic.trim()) parts.push(identityStatic.trim());
  if (settings.systemPrompt && settings.systemPrompt.trim()) parts.push(settings.systemPrompt.trim());
  if (settings.characterProfile && settings.characterProfile.trim()) parts.push('[Character Profile]\n' + settings.characterProfile.trim());
  if (settings.userProfile && settings.userProfile.trim()) parts.push('[Human Profile]\n' + settings.userProfile.trim());
  parts.push(GUIDE_TOOLS_INFO);
  parts.push(GUIDE_NO_JARGON);
  return substituteMacros(parts.join('\n\n---\n\n'), settings);
}
