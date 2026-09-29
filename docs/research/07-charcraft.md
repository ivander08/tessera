# Character Craft — what makes a good AI roleplay card, and how to help a user build one

Research for a BYOK AI roleplay client (chub.ai alternative). All URLs read 2026-09-29 unless the source states its own date.
**Access note:** `reddit.com`/`old.reddit.com` are DNS-sinkholed on this host and `api.pullpush.io` returned HTTP 429 on every attempt. Reddit material was read through the Redlib mirror **`safereddit.com`**, which preserves post ids, authors and UTC timestamps. Every Reddit claim below carries an author + date.

---

## 0. The structural fact everything else follows from

A card is not a document. It is a **fragment of a prompt reassembled from scratch on every generation**, and its fields have wildly different lifetimes.

SillyTavern's docs draw the line explicitly (https://docs.sillytavern.app/usage/characters/characterdesign/):

> "**What are a Character's 'Permanent Tokens'?** These will always be sent to the AI with every generation request: Character Name / Character Description Box / Character Personality Box / Scenario Box"
> "**What parts of a Character's Definitions are NOT permanent?** The first message box - only sent once at the start of the chat. Example messages box - only kept until chat history fills up the context (optionally these can be forced to be kept in context)"

Three tiers, and every piece of craft advice below is really advice about which tier a fact belongs in:

| Tier | Fields | Cost model |
|---|---|---|
| **Permanent** (every turn) | `name`, `description`, `personality`, `scenario`, Character's Note, constant lorebook entries | Multiplied by every message in the chat |
| **Ephemeral, front-loaded** | `first_mes`, `alternate_greetings`, `mes_example` | Paid once, or until evicted block-by-block — the cheapest place to buy style |
| **On-demand** | keyed lorebook entries, Author's Note at depth | Paid only when triggered / only once per N messages |

**Design consequence:** the greeting and example dialogues are the only fields where verbosity is nearly free; description/personality/scenario are where it compounds. Every "disagreement" about card length is really an argument about which tier a fact belongs in.

How fields actually enter the prompt (needed for an accurate token counter):
- **Text Completion APIs** — Handlebars "Story String": `{{description}}`, `{{personality}}`, `{{scenario}}`, `{{char}}`, `{{user}}`, `{{wiBefore}}`/`{{wiAfter}}`, `{{mesExamples}}`. "If any of the above parameters are missing from the story string template, they will not be sent in the prompt at all." (https://docs.sillytavern.app/usage/prompts/context-template.md)
- **Chat Completion APIs** — Prompt Manager pinned prompts: Character Description, Character Personality, Scenario, Chat Examples, Chat History, Post-History Instructions. Drag-and-drop order; **the bottom of the list is the last thing sent**. (https://docs.sillytavern.app/usage/prompts/prompt-manager.md)
- Tokenizer: "one token generally corresponds to 3~4 characters of text" (https://docs.sillytavern.app/usage/prompts/tokenizer.md)

---

## 1. Field-by-field guidance

### `name`
Only required field: "Character Name is the only required field. You can leave the rest empty and still use the character in chats." (ST docs)

- **Names carry priors.** Trappu: "Each name is more than just a name; it contains bits of information" — 'Caera Denoir' implies a noblewoman. The trap is the reverse: "If you write an OC, or a character with the same name as another popular character, chances are that the model will already have knowledge of that more popular character." (https://wikia.schneedc.com/bot-creation/trappu/creation)
- Chub exposes a separate **In-Chat Name**: "I may want the display name to be 'Generic Anime Protagonist' whilst having the name while chatting be 'Midoriya.'" (https://docs.chub.ai/docs/the-basics/character-creation.md). JanitorAI calls it "Character Chat Name" ("Dan Smith, The Hound" → "The Hound").
- StatuoTW on in-chat names: "If you have your full ass character name: Frederico Guandamo Pierro Vallermo III, it's going to get real old real fast." (https://rentry.co/statuobotmakie)
- Ali:Chat: "For the character's name, using the first name can help the AI process it easier." (https://rentry.co/alichat)
- CCv3 adds `nickname`, which replaces `{{char}}`/`<char>`/`<bot>` in the prompt instead of `name` — the spec-blessed solution to the long-display-name problem.

### `description`
ST: "Used to add the character description and other relevant information for the AI. This information is always included in the prompt, so all important facts should be included here." … "It could be of any length (be it 200 or 2000 tokens) and formatted in any style (free text, pseudo-code conversation style, etc.)." ST then punts: "Methods of character formatting are a complicated topic beyond the scope of this documentation page."

What good content looks like:

- **Show, don't tell.** The most repeated advice in the corpus. ST's own Prompts page: "Use this to your advantage by also providing example messages showing how you want the AI to respond. **Showing what you want is often easier than trying to explain it!**" (https://docs.sillytavern.app/usage/prompts/)
- **The description's prose style leaks into the character's voice.** NG: "the way you write the card definition, itself, influences how the {{char}} responds." (https://rentry.org/NG_CharCard) API-Beast: "the character description seeps into the writing style of the AI, it's much more important to nail the 'vibe' of the character than to mention every unimportant detail." (r/SillyTavernAI 2023-11-07, https://safereddit.com/r/SillyTavernAI/comments/17pp25a/)
- **Card-as-prompt.** Hochi: "your card is nothing other than a part of one big prompt… it makes sense to not just list all the bot traits, but also give the AI directions on what exactly you want it to do with them." (https://web.archive.org/web/20230712205614/https://rentry.org/OnWritingCards)
- **Ali:Chat** puts *dialogue examples inside the Description box* (permanent) rather than the Examples box (evicted). Structure: one-line persona → `<START>` → `{{user}}:` / `{{char}}:` exchanges. "Every dialogue example should express character attributes/traits through dialogue and/or *actions*." "The bottom has the highest strength and the top is the lowest strength." (https://rentry.co/alichat)
- **PList** (kingbri's compressed variant): `[Character's persona: traits; Character's clothes: traits; Character's body: traits; Genre: genre; Tags: tags; Scenario: scenario]` — "do **NOT** split up PList entries… reduce the chance of your bot leaking since more arrays give more variability to the AI." "Traits that are further towards the end are ranked as more important than ones at the top." (https://rentry.co/kingbri-chara-guide)
- **Behaviour engines beat adjective lists.** QuietPalimpsest (r/SillyTavernAI 2026-09-19): "'Claire is confident, charming, loves to party, but is quick to anger and quietly depressed' … Does that generate behaviour? Absolutely. [vs.] 'Claire needs something to be happening. Silence doesn't stay quiet for long in her head — it's quickly filled in by noise, by her father's voice telling her she's been a waste of his money…' This generates more realistic, compelling behaviour." (https://safereddit.com/r/SillyTavernAI/comments/1wkxoz5/)
- **KISS.** NG: "I see authors putting *way* too much info into their cards… `{{char}} is angry but friendly.` What is the LLM supposed to do here?" Hochi: "One 'machiavellian' is worth three 'manipulative, clever, immoral'."
- **Established characters need almost nothing.** NG: "Under no circumstances should you be cut/pasting entire wiki articles on well known NPCs. That's just terrible craftsmanship." His demo card's entire description is `{{char}}` where the name is Harry Potter.

### `personality`
ST: "A brief summary of the character's personality." Three-way split:
- **Minimalists**: Ali:Chat — "keep brief just to reinforce certain traits", and disable ST's personality formatting so you can use your own PList/SBF inside it. StatuoTW says leave it blank.
- **Maximalists**: AbsoluteTrash — "I usually assign 15 to 20 personality traits to my characters. While this may seem excessive, I find that characters with fewer traits often appear less 'real.' The bot tends to consistently exhibit the same limited behaviors, which can make them predictable and repetitive." (https://rentry.co/absolutetrashs-bot-guide)
- **Counterweight**: NG's KISS — "More traits, more risk of inconsistencies for the LLM to try to square."

Practical resolution: the personality box's real job is **re-stating traits that decay**. NG: "Since the AI will tend to forget accents over time, add it back in using the Personality field." RisuAI's source marks its `personality` and `scenario` fields as *unrecommended* — a modern frontend deciding they're vestigial.

### `scenario`
ST: "The circumstances and context of the dialogue." Chub: "The current circumstances and context of conversation and character."

- Can be blank. StatuoTW: "**This can be left blank.**… A good introduction message and the user making use of Authors Note/Chat Memory will carry most introduction scenarios." Ali:Chat agrees.
- **Scenario must be static world facts, not an event.** Joystick: "Scenario field is too strict, trapping your bot in a specific event. You can counter this by making sure anything in the scenario field is an unchanging fact of the world. Character relationships, the setting, etc." (https://rentry.co/Joystick_Tips)
- JanitorAI frames it as "setting your bot takes place in, the time period, or a very short description of the character's relationship to the user's persona."

### `first_mes` (first message / greeting) — the highest-leverage single field
ST: "The First Message is an important element that defines how and in what style the character will communicate. **The model is more likely to pick up the style and length constraints from the first message than anything else**, so it's important to write it in a way that you want the responses to be (short and concise, long and detailed, etc.)."

Near-unanimous across official docs and community guides:
- Trappu: "even a card with the best PLists + Ali:Chat description possible will perform much worse if the greeting message is low quality." And on placement: it "is always the lowest in context at the beginning of the conversation, meaning that it has a massive impact on your character's writing style at the start."
- AVAKSon: "the greeting message is actually the most powerful tool you have in your disposal to push model into following your character persona. It is the lowest point in the context." Length: "it's 5 lines minimum, 7 maximum. With that you set starting point for the length of model responses." (https://rentry.co/plists_alichat_avakson, via Wayback 2024-12-09)
- r/SillyTavernAI 2024-01-03: "**do not go low effort on the First Message.** … If all you're putting is 'Hi' or '*character waves*' 'Hi {{user}} how are you?'' then that's exactly the type of response you're going to get no matter how good your Description is." (https://safereddit.com/r/SillyTavernAI/comments/18x4oie/)
- ST FAQ operationalises it — to make the AI write *more*: "Design a good `First Message` for the Character, which shows them speaking in a long-winded manner." To make it write *less*: "Give the character a brief First Message to set the tone and expectation for the chat." (https://docs.sillytavern.app/usage/faq.md)

**Hochi's greeting checklist** (the most complete rubric found):
1. Establishing the premise
2. Establishing the surroundings
3. Giving a brief description of the character
4. Incorporating the character's speech quirks
5. Stating the relationship of char and user (or lack thereof if it's their first meeting)
6. "Making sure that the length of greeting, tone, style and action-to-dialog ratio are roughly the same as you want to see in every message"

**The hard rule: never write `{{user}}`'s actions or dialogue in the greeting.** This is not stylistic — it *causes* ongoing impersonation. Trappu: "a common mistake people make is using the greeting message to narrate the user's actions. This will tell the model that it's fine to impersonate the user. It's fine if this is intended, but if not, make sure the character describe their actions only." Ali:Chat: "if your character card… contains a first message or example dialogues where the character speaks on your behalf/impersonates you… it's simply going to carry over." NG gives the mechanism: "Once you've given the AI permission to talk as {{user}}… it will continue to do so, b/c at the core the 'AI' is really just a 'Text Completion Engine.' It really likes to copy what it did before. So don't let it start."

Nuance: scene-setting that describes the user's *surroundings and emotional context* without dictating an action is fine. NG's good example ends "Player could literally do anything at this point and be 'in character,' from breaking down in tears to getting angry and leaving."

JanitorAI's official guidance: "Any perspective may be used, though **third person often provides the best roleplay results in terms of preventing LLMs from speaking for the user**."

Ali:Chat adds: "questions can loop over and over again when starting a new chat. To prevent this, remove the leading question from the greeting message."

### `alternate_greetings`
CCv2: "Array of strings. Frontends **MUST** offer 'swipes' on character first messages, each string inside this array being an additional 'swipe'."

Chub's format requirement is a gotcha: "When making alternate greetings it is **required** that you append `<START>` at the beginning of each message so that we can know when each message ends and begins and properly display them."

Advanced Card Writing Tricks (https://rentry.org/AdvancedCardWritingTricks):
- "Writing alternate greetings *and* a summary of each one inside the creator's notes makes people more likely to feel inspired by your card… **Cards are prompts not just for the AI but also for humans.**"
- "the first greeting should contain all information which you want the user to have about your character… it's alright to assume that the user is already familiar with the necessary information in subsequent greetings, which can skip the introductory information and can focus on providing categorically different setups."
- "ensure that your main defs and example messages are still applicable to every greeting."

CCv3 adds `group_only_greetings` — greetings used only in group chats.

### `system_prompt` (Main Prompt override)
ST: "If the 'Prefer Char. Prompt' user setting is enabled, any text you put here will override the main/system prompt for the character." Default main prompt: `Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.` `{{original}}` splices the default back in.

CCv2 makes the override mandatory-ish: "Frontends' default behavior **MUST** be to replace what users understand to be the 'system prompt' global setting with the value inside this field."

What it's actually for — **cards that aren't a 1:1 roleplay**: 4chan threads, Reddit AITA posts, Discord logs, diaries, Linux terminals. "Before V2 cards, you would often write in the main defs '{{char}} is not a character but the narrator of…'. This flimsy workaround is no longer needed." Example given: `Write two related but ultimately separate story lines that follow the lives of the same soul in different time periods.`

Counter-advice: StatuoTW says "you should **leave this field blank**." AbsoluteTrash says jailbreaks "do not go in the description/personality sections… They go into the Main Prompt/System Prompt in the following format: `{{original}}, Your jailbreak here.`" Advanced Card Writing Tricks offers the pragmatic hedge: "because certain users have card system prompts disabled (or downloaded the V1 card), you want to keep information crucial to the card inside the main defs."

### `post_history_instructions` (PHI / card jailbreak)
ST: "Since the Post-History Instructions are sent after the user message, they are the final instructions that the AI receives before generating a response. **The AI usually gives them a higher priority than the main prompt, and they can override the main prompt's instructions.**"

CCv2: "Frontends' default behavior **MUST** be to replace what users understand to be the 'ujb/jailbreak' setting with the value inside this field"; `{{original}}` MUST be supported.

Ordering `{{original}}`: "if in doubt, make it follow it. This will give the user's jailbreak more weight than yours, but they won't have bad surprises with their usual jailbreak being less effective than usual because of your card jailbreak."

Real examples (all from Advanced Card Writing Tricks):
- `Response must NEVER start with a character's name. Response MUST end with either dialogue or an action.` / `BANNED WORDS AND ACTIONS=[wink, smirk, mischief, mischievous]…`
- `[Write all narration in the style of Flannery O'Connor. Do not speak for {{user}} or write {{user}}'s actions.] {{original}}`
- `<writing_task>Write Angie's response… emulating the writing style in her diary from the diary XML tag. Follow the instructions in the story_flow XML tag…</writing_task> {{original}}`

**Rendering/XSS note:** card defs and PHI routinely contain raw HTML (`<img>`, `<span style=…>`, `<marquee>`, `[](#'…')`). The same guide documents frontend quirks: "Silly: Supported, but HTML attributes cannot be double-quoted… Venus: Supported, but HTML attributes cannot be double-quoted… Agnai: Supported. Risu: Supported. Note: JavaScript is filtered out." Rendering card HTML inherits a sanitizer obligation.

### `creator_notes`
CCv2: "The value for this field **MUST NOT** be used inside prompts. The value for this field **SHOULD** be very discoverable for bot users (at least one paragraph **SHOULD** be displayed)."

Two real uses beyond a README:
1. **Human-facing prompt.** Summarise each alternate greeting so "people feel inspired by your card." Also: "the first greeting should contain all information which you want the user to have about your character… without assuming that the user has read the Chub tagline, creator's notes, or defs."
2. **Warning label.** JanitorAI: "If you used the 'Dead dove' tag, appropriate trigger/content warnings should be inserted here!"

CCv3 adds `creator_notes_multilingual` (ISO 639-1 keys, no region code) — worth supporting since card sharing is heavily non-English.

### `tags`
CCv2: "There is no restriction on what strings are valid. This field **SHOULD NOT** be used in the prompt engineering. This field **MAY** be used for frontend sorting/filtering purposes (**SHOULD** be case-insensitive)."

But Trappu argues tags leak behaviourally: "Tags: Sets the tone for the scenario, indicates to the model which elements it can introduce" — "The impact of tags is extremely underrated." (Some frontends do inject them; Chub's docs call tags "just for searching.")

Hard rules: Chub — "characters with less than three tags will be hidden in search." JanitorAI — max 10 tags, at least one of Limited/Limitless. StatuoTW: "**Tag your bots.**"

### `character_book` (embedded lorebook)
The escape hatch from permanent tokens. CCv2: "Frontends **MUST** use the character lorebook by default… Character lorebook **SHOULD** stack with user 'world book'… (Character book **SHOULD** take full precedence over world book.)"

Chub: lorebooks "serve content to the AI about the character's backstory, setting, environment, etc **without needing to have it be in character definitions taking up permanent token space**." (https://docs.chub.ai/docs/advanced-setups/lorebooks.md)

The craft warning about timing: "since **lorebook entries are not inserted mid-generation**, what will happen is that **the character will first bring up the topic while lacking the information inside the lorebook entry, and only in the next message will they have that information in the prompt**." Keyword selection follows: "An entry's keywords SHOULD be things which either the character or the user will bring up."

Chub's entry schema (9 fields, quoted): Keywords, Secondary Keywords, Content, Insertion Order ("the lower the insertion order, the higher the entry is inserted"), Case Sensitivity, Priority, Selective & Selective Logic ("If you have a keyword 'Apple' and secondary keyword 'Banana' with a Selective Logic of 'NOT'… Insert this entry if 'Apple' is found and 'Banana' ISN'T found."), Constant, Probability.

### Fields most people forget exist
- **Character's Note** — in-chat injection at fixed depth. ST: "it always stays at a static depth in the chat history, regardless of its progression." Chub: "Numbers between 1 and 5 are recommended." This is how you re-assert a trait mid-chat without paying permanent tokens.
- **Talkativeness** (ST, group chats): 0% Shy → 100% Chatty, default 50.
- **CCv3 `assets[]`**: typed `icon`/`background`/`emotion`/`user_icon`, `embeded://` and `ccdefault:` URIs; `emotion` assets matched by `name` (`happy`, `sad`, …).
- **CCv3 lorebook decorators**: `@@depth`, `@@activate_after`, `@@position`, with `@@@` fallback chains.

---

## 2. Token efficiency: the actual numbers

### Hard, official numbers (safe to cite as fact)
| Fact | Source |
|---|---|
| Permanent = Name + Description + Personality + Scenario | https://docs.sillytavern.app/usage/characters/characterdesign/ |
| ST flags a card red when it exceeds **half the model's context** | same |
| "If you're working with an AI model with a 2048 context token limit, **a 1000-token character definition cuts the AI's 'memory' in half**" | same |
| "a decent response from a good AI can easily be around 200-300 tokens… the AI would only be able to 'remember' about **3 exchanges**" | same |
| 1 token ≈ 3–4 characters | https://docs.sillytavern.app/usage/prompts/tokenizer.md |
| World Info default budget = 25% of context | https://docs.sillytavern.app/usage/worldinfo.md |

### Community size targets (heuristics, NOT measurements — label them as such in-product)
| Era / source | Target | URL |
|---|---|---|
| 2023 minimalist doctrine | total < 600, or permanent < 600; Ali:Chat examples 300–600 | https://rentry.co/kingbri-chara-guide |
| StatuoTW (updates to 2025-03) | 400–700 permanent; hard cap 1k for beginners | https://rentry.co/statuobotmakie |
| r/SillyTavernAI NAI creator, 2024-01-03 | ~400–600 permanent, 1000+ floating | https://safereddit.com/r/SillyTavernAI/comments/18x4oie/ |
| AbsoluteTrash (JanitorAI) | 800–1200 for beginners; don't exceed ~1500 permanent | https://rentry.co/absolutetrashs-bot-guide |
| r/SillyTavernAI, 2025-09-10 | "**the sweet spot for a card to be between 1k-2k tokens**" | https://safereddit.com/r/SillyTavernAI/comments/1nd54s0/ |
| likesumiink, 2026-08-20, measured rebuild | 490 → ~1300; "1000-1500 sweet spot, up to 2k with fantasy" | https://likesumiink.substack.com/p/tuning-pre-existing-cards-for-texture |
| JanitorAI official docs (updated 2026-08-11) | "remain under **2500 permanent tokens**… going past it can run you the risk of quicker memory degradation" | https://help.janitorai.com/en/article/the-basics-the-character-creation-page-overview-15xevon/ |
| JanitorAI community guide (2025-05-09) | "preferable not to write over **2k permanent tokens (2.5k absolute max)** if you want your bot to be usable with JLLM" | https://help.janitorai.com/en/article/bot-creation-guide-w-images-by-faylua-8jcbw1/ |
| Porting guide, 2026-04-30 | "no more than **8k permanent tokens** on the card with a context of 128k. Double for 256k" | https://safereddit.com/r/SillyTavernAI/comments/1t0d12m/ |
| Premium tier cards, 2026 | 3.6k–8.1k permanent advertised as a selling point | https://safereddit.com/r/SillyTavernAI/comments/1unlqrr/, /1ua6qno/ |
| Utility extreme | "Tension Narrator (96 tokens, 18 permanent)" | https://safereddit.com/r/SillyTavernAI/comments/1gakg7o/ |

### 50-token vs 2000-token cards, concretely
- **50–200 tokens**: "Even a **50-200 token prompt can be enough if you start the conversation the right way**" (u/Boring_Isopod2546, 2023-10-17). Trollolo80: "some characters ranging from 50 to 200 have really low details."
- **~350 tokens**: "Some of my favorite characters are around 400 tokens, and they end up being the most consistent… my favorite character… is under 350 for its perm token count." (u/FreekillX1Alpha, 2023-10-16)
- **~18 permanent tokens**: the Tension Narrator utility card.
- **1500-token description alone**: the OP of the 2500-token thread; community reaction uniformly "too much."
- **2500 tokens**: top answer — "**Yes. You can likely trim that down.**"; "pretty much half of that would still be considered on the high side."

### The bloat complaints, verbatim
- "That eats into the context. A normal 4096, half+ of your memory is the character card." (u/a_beautiful_rhind, 2023-11-07)
- "The bot will often ignore these entries anyway… all the information will be a **dead weight**." (u/Loofy_, 2023-10-16)
- "I've seen some cards going up to 4000… repeating themselves, full of grammar mistakes, insignificant details, heavy and almost never-ending descriptions." (u/Creative_Progress803, 2023-10-20)
- AbsoluteTrash's measured-sounding claim: "having more permanent tokens tends to result in the LLM **overlooking more information or even providing incorrect information**" — with a concrete case: "If you have 'avoids eye contact' under the 'mannerisms' section… When the token count is 1500 or lower, the bot typically avoids eye contact… as the available tokens increase beyond this threshold, the bot begins to make eye contact."
- "too large of a context window. Models break down the larger this gets, just in general, and also all the conversation starts to drown out the more important core instructions." (2025-12-14, https://safereddit.com/r/SillyTavernAI/comments/1pmjn2n/)

### The single loudest recent complaint: instructions smuggled into the description
r/SillyTavernAI, 2026-09-13, u/Nezeel: "in the damn description, at the end of everything, there are shits like these written: [System rules: Write thoughts between asterisks! blah blah blah use these markdowns!! … just write a maximum of 4 paragraphs! blah blah blah] … there are 40 more instructions that in the end make **50% of the tokens padding**. PLEASE, THE PROMPTS ALREADY TAKE CARE OF THESE THINGS, DO NOT ADD THEM." (https://safereddit.com/r/SillyTavernAI/comments/1wf11qf/)
u/No_one_003 in the same thread: "Sometimes I download a 2k token bot and then find out half the tokens are actually system instructions." Origin, per u/DaddyWentForMilk: JanitorAI creators compensating for users who never configured prompts.

### Counter-arguments that long descriptions help
- **Prompt caching makes trimming the cacheable prefix nearly pointless.** "Every major AI API now — Claude, Gemini, GPT, DeepSeek — have prompt caching… **Usually, this is 90% cheaper.** So if you cut preset in half 'for saving tokens' then your real costs will drop for **less than 10%** while quality of generated text will degrade drastically." (2026-07-20, https://safereddit.com/r/SillyTavernAI/comments/1v1l6lz/) — *about the preset/system prompt; transfers only partially to card fields, and it is an argument, not a measurement.*
- **PList's compact syntax is not actually cheaper.** "often special characters like ; ( and so on **become their own token**, so writing lists heavy with them doesn't necessarily save any tokens, and often in fact **wastes them compared to natural language**." / "`Name: Adam;` 'His name was Adam' are just as many tokens and contain more information given the gender is included." (2025-09-10, /1nd54s0/)
- **Prose carries voice.** "Naturalistic language using well-written prose will always give you more depth… sooner or later at higher token counts your characters are going to sound flat and samey if you're only using PList." / "Naturalistic prose also has the advantage that you can use it to effectively be **additional sample dialogue**." (same thread)
- **The counter-counter:** "long descriptions can overwhelm the context and become the main thing the model is paying attention to. It's up to you whether that's desirable or not."

### Honest gap
**No controlled A/B test exists** in the corpus that holds a character constant and varies only token count while measuring output quality. The two "measured" data points are token deltas with asserted quality (kingbri 1300→599; likesumiink 490→1300). Every "optimal" figure is a single author's heuristic.

**Product implication:** show permanent tokens prominently and separately; show a per-turn projection (permanent × messages) so the multiplicative nature is visible; offer one-click lorebook extraction; surface the caching caveat rather than implying token count is money.

---

## 3. `mes_example` — the highest-leverage field

### Normative definition — CCv1 spec
https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v1.md
> `mes_example` — Example conversations. It **MUST** be expected that botmakers format example conversations like this:
> ```
> <START>
> {{user}}: hi
> {{char}}: hello
> <START>
> {{user}}: hi
> Haruhi: hello
> ```
> `<START>` marks the beginning of a new conversation and **MAY** be transformed… Example conversations **SHOULD**, by default, only be included in the prompt until actual conversation fills up the context size, and then be pruned to make room for actual conversation history. This behavior **MAY** be configurable by the user.

The same spec fixes macro substitution across `description`, `personality`, `scenario`, `first_mes`, `mes_example`: `{{char}}`/`<BOT>` → card `name`; `{{user}}`/`<USER>` → display name, **case-insensitive**.

### ST's exact format rules and what actually happens at runtime
ST docs: "Before each example, you need to add the `<START>` tag… `<START>` will not be present in the prompt as it is just a marker; it will be replaced with the 'Example Separator' from Advanced Formatting for Text Completion APIs and the contents of the 'New Example Chat' utility prompt for Chat Completion APIs." "Use the `{{char}}:` prefix… `{{user}}:` prefix."

Verified in ST source (`public/script.js`, `parseMesExamples()`, ~L3498–3512):
```js
if (!examplesStr.startsWith('<START>')) { examplesStr = '<START>\n' + examplesStr.trim(); }
const splitExamples = examplesStr.split(/<START>/gi).slice(1).map(block => `${blockHeading}${block.trim()}\n`);
```
So ST auto-prepends a missing `<START>` and splits case-insensitively. Replacement happens in `formatInstructModeExamples()` (`instruct-mode.js`): `item.replace(/<START>/i, '{Example Dialogue:}')`. The block header becomes the **Example Separator** (default `***`, per `default/content/presets/context/Default.json`); for Chat Completion APIs the preceding utility prompt is **New Example Chat**, default `[Example Chat]`.

Chat Completion path: `setOpenAIMessageExamples()` → `parseExampleIntoIndividual()` (`openai.js`) emits real `{role, content, name}` objects tagged `example_user` / `example_assistant`, surfaced in Prompt Manager under the pinned **"Chat Examples"** prompt.

### Is it permanent? No, by default
Confirmed three ways: the docs list above; the User Settings option **Example Messages Behavior** (Gradual push-out / Always include examples / Never include examples); and the source (`pin_examples`, `strip_examples`; `Generate()` accumulates blocks until `tokenCount < this_max_context`, then `mesExamplesArray.slice(0, count_exm_add)`). Trappu's table states it plainly: "Description box: permanent tokens / **Examples of dialogue box: temporary tokens (permanent if the setting is enabled)** / Greeting message: temporary tokens".

**Practical consequence:** if you want the style to persist late in a long chat you must either pin examples or move the styling into a permanent field. This is exactly why Ali:Chat duplicates examples into Description.

### Placement
- **Text Completion**: rendered story string first, then example blocks, then chat history. "By default, the rendered story string (with all placeholders replaced) is placed at the very beginning of the prompt, followed by example messages and the visible chat history." Custom templates can use `{{mesExamples}}` / `{{mesExamplesRaw}}` — with the warning: "When using `{{mesExamples}}` in the Story String, set **'Example Messages Behavior'**… to **'Never include examples'** to avoid duplicating example messages in the prompt."
- **Chat Completion**: real messages under the Chat Examples marker, bounded by New Example Chat and Chat Start.
- **Separators as Stop Strings**: "Helpful if the model tends to hallucinate or leak whole blocks of example dialogue preceded by the separator."

### Why it's high-leverage
ST's own framing: "**Showing what you want is often easier than trying to explain it!**" Examples are literal assistant-role continuations in the register you want, so they condition surface form — sentence length, punctuation, asterisk-vs-quote convention, slang, catchphrases — far more strongly than an adjective list. Ali:Chat's premise: "using dialogue as the formatting to express and reinforce traits/characteristics."

Field evidence for its power — r/SillyTavernAI, 2025-05-20, u/Round-Sky8768: "I've been trying for the past few days to set up a mute character who uses a journal to communicate, and the story would *always* randomly give him a voice within 15 or so messages… discovered the example messages and bam!… the character has been super consistent since then."

And on their absence (r/SillyTavernAI 2024-02-13, u/Bite_It_You_Scum): "at some point the greeting message and anything you put into the actual Example Dialogue section will be pushed out of context. And you can literally tell when it happens if there's no example dialogue in the description, because shortly after, your character's personality will become noticeably more generic… it will sort of blend them together into a generic mush that sucks all the life out of your character."

### How many, how long
| Source | Guidance |
|---|---|
| Ali:Chat | "Create 2 long examples or 3 short examples (I recommend 3 short)"; 300–600 tokens total |
| Trappu | "If you write long example dialogues (~150 tokens each), then 1 alone could be enough, however, 2 will guarantee that your character will work properly… **Quality > Quantity**!" |
| AbsoluteTrash | "Have around **500 tokens** of dialogue, and try to **not go above 800**" |
| ParasiticRogue, 2025-03-07 | "I like to have multiple example messages, say in the **3~7 range**… so the character can express multiple emotions and scenarios" + "varying message length itself, in order to ensure the bot doesn't get comfortable in a certain range" |
| HowWasRoyadinTaken, 2023-10-16 | "I always do at least **six** examples" |
| ConsiderationNo9044, 2023-07-16 | "Just a few, like two or three back and forth responses should be enough" |

**Consensus: 2–6 blocks, 300–800 tokens total.** Enough to cover different emotional registers; few enough that the model doesn't lock onto one.

### Block shape and ordering
- Everything between two `<START>` tags is one conversation; blocks may be 2 messages or many. A block may start with `{{user}}:` or `{{char}}:`.
- Ali:Chat: "Make sure every `{{char}}` dialogue has a `{{user}}` dialogue between it." But a `{{char}}`-only block is legal: "you can write with just `{{char}}` without ever mentioning `{{user}}`. That works too."
- **The last example should overlap with the greeting.** Ali:Chat: "The last dialogue example should be relevant to your 'First Message' box… It's important that there's overlap between the Hidden Scenario dialogue example and the First Message for it to work consistently."
- **"Pregreeting"** — examples set *before* the greeting: "This technique sidesteps two common issues with example dialogue: The AI thinking example dialogue happened (this is, in this case, exactly what you want!) [and] The AI following the example dialogue too much when similar situations occur."
- **Examples can carry instructions:** `{{user}}: [System: Instruction goes here]` — "example messages are 'ephemeral tokens' and with craftiness can be made to contain not just example dialogue but any instruction that you are fine with it being dropped when exiting the context window."

### Common mistakes (all sourced)
1. **Leaking plot into unrelated chats.** "I remember doing an RP with a bot that had example messages about cooking some food, and in the current the bot would mention what I'm going to be making tonight even though the RP had nothing to do with cooking." (2023-07-15) → keep examples generic in *subject*, specific in *voice*, or use pregreeting framing.
2. **Writing `{{user}}`'s actions inside the `{{char}}` turn.** Trappu: "a common mistake people make is writing example dialogues where the character describes the user's actions on their behalf. This will indicate to the model that it's fine to impersonate the user."
3. **Reusing one verb.** Ali:Chat: "Be **very** careful with overlapping verbs (like 'smiling'), it is much better if you use synonyms and use each verb only once."
4. **Formatting inconsistent with the greeting.** Regular_Ad1368: "If you bold your dialogue, bold it in both the first message and the example messages."
5. **Non-existent macros.** AbsoluteTrash: "many people use non-existing macros like {{random_user_1}} or a character name like {{Cooler Daniel}}. If you do this, the model is going to legitimately think there is a character or concept that is {{Cooler Daniel}}."
6. **Assuming permanence.** They are evicted block-by-block unless pinned.
7. **Quotes when the rest of the card doesn't use them.** Ali:Chat: "Quotation marks are not recommended, as this could confuse the bot into thinking it's a novel and not a chat." Trappu: "Just don't do this weird hybrid style (`"Hi," *she said.*`). Models aren't gonna like it."
8. **Verbatim echo.** Moogs72 (2026-05-20): "modern SOTA models will be just grabbing any example sentences you use verbatim and will throw them at you constantly." Ali:Chat treats mild leaking as a feature while warning "environment leaking could cause your conversation to switch locations."

### The documented alternative: vocabulary + speech pattern
r/SillyTavernAI, 2024-06-29 (52 upvotes): "So I gave up completely on example dialogues and just added the following towards the end of the character description: `### sample vocabulary` … `### {{char}}'s speech pattern` … it felt like overall an actual coherent personality, instead of repeating examples (or worse, thinking it's part of the chat's history)." A reply generalises the trick: use hedged framing ("their desired reaction might be along the lines of…") so the model adopts the style without repeating the line.
**Trade-off to expose in-product: examples buy format fidelity; vocabulary lists buy variety.**

### Known structural bug in the mainstream frontend
ST's instruct-mode formatting wraps examples as chat messages and, per a well-argued community analysis (r/SillyTavernAI 2024-02-11, u/Worldly-Mistake-8147, https://safereddit.com/r/SillyTavernAI/comments/1anz4p1/): "This breaks user-assistant turn order. They get injected inside the first user's turn (ie between `<|im_start|>user` and `<|im_end|>` which breaks sequence order in the most important message where the character is described." He shipped a patch that folds examples into the character description block instead and reported better adherence. A 2025 reply: "I am surprised nobody has mentioned this before or since; the placement of example dialogues in normal ST doesn't seem to make sense!!"
**Implication for us: choose example-block placement deliberately** rather than inheriting ST's accident.

### Verbatim example blocks from real cards
**ST's own documented example** (Seraphina):
```
<START>
{{user}}: "Describe your traits?"
{{char}}: *Seraphina's gentle smile widens as she takes a moment to consider the question…*
<START>
{{user}}: "Describe your body and features."
{{char}}: *Seraphina chuckles softly, a melodious sound that dances through the air…*
```
**Real Ali:Chat card** (Harry Potter, https://files.catbox.moe/2dn4ll.json, exported by ZoltanAI AI Character Editor 0.5.0, created 1680504972962) — examples live at the top of `description`; `mes_example` is empty:
```
<START>
You: Describe your features and body.
Harry Potter: *Harry Potter gives a self-conscious smile, shifting in his seat and rubbing the back of his neck.* Well, I'm not exactly the tallest bloke around… *He gestures towards his untidy, jet-black hair that never seems to cooperate…*
```
**Minimal legal CCv2 shape** (https://github.com/bradennapier/character-cards-v2/blob/main/examples.md):
```json
"mes_example": "<START>\n{{user}}: Your majesty, how do you plan to confront the looming threat?\n{{char}}: We shall unite our forces and stand strong. Our kingdom's future is built on our unity.",
```

---

## 4. Existing creation workflows and tools

### Editors
| Tool | URL | What the editor exposes | Verdict |
|---|---|---|---|
| **SillyTavern** | https://docs.sillytavern.app/usage/characters/ | Description, First Message, Alt greetings, Main Prompt, PHI, Creator metadata, Personality, Scenario, Character's Note (+depth+role), Talkativeness, Examples. Token counter (total + permanent) that turns red past half context. World Info is the standout: regex keys, AND ANY/ALL + NOT ANY/ALL filters, 9 insertion positions, outlets, inclusion groups, group weight/scoring, timed effects, vector matching. | Most complete, worst UX. Advanced fields hidden behind a book icon. No built-in AI generation. |
| **Chub.ai** | https://docs.chub.ai/docs/the-basics/character-creation.md | Info: Name(req), Avatar, Tagline, In-Chat Name, Creator's Note, Tags, Type, Rating. Definition: Description(req), Initial message(req), Scenario, Example dialogs. Advanced: Alt greetings, System Prompt, Post Hist Instructions, Character's Note (depth 1–5), Character Book. 14 Handlebars macros incl. `{{random:}}`, `{{roll:}}`, `{{idle_duration}}`, `{{level}}`, `{{model}}`. Separate Lorebook Creator. | Cleanest wizard, good macro docs. **No AI assist and no token counter documented** in the creator. Its docs decline to teach craft: "If you want to know how to make a *good* character, there have been numerous people that have covered that far better than I could." `<3` tags = hidden from search. |
| **JanitorAI** | https://help.janitorai.com/en/article/the-basics-the-character-creation-page-overview-15xevon/ (updated 2026-08-11) | Bot Image(req), Name(req), Chat Name, Bio (HTML, **not sent to the bot**), Tags (max 10), Limited/Limitless, Personality(req), Scenario, Initial Message(req), Example dialogs. Total + permanent token readout. | **No separate `mes_example` field** — "It is currently suggested to include any dialogue examples in the Personality box," which makes them permanent. Official 2500-permanent-token guidance. New bots default private. Scripts framework = JS lorebooks with depth/probability/inclusion groups. |
| **RisuAI** | https://github.com/kwaroran/RisuAI (★1.7k, GPL-3.0) | 7 editor tabs. Basic (Name, Description+count, First Message+count, Author's Note+count), Display (icon, emotion table, additional assets incl. mp4/ttf/css), Lorebook, Scripts (background HTML, regex, trigger scripts, charjs), TTS (11 providers), Advanced (Bias table, example message, multilingual creator notes, system prompt, personality/scenario marked *unrecommended*, defaultVariables, nickname, depth_prompt, alt greetings with reorder, SupaMemory/HypaMemory V2/V3), Share. V3-native: imports `ccv3`/`chara` PNG chunks, `.charx`, charx-JPEG; exports CHARX (`card.json` + `module.risum`). | Most technically ambitious; CCv3 originated here. Weakest docs ("wiki — Work in Progress"). No AI card generator in source [INFER]. |
| **AiMaker** | https://github.com/altkriz/aimaker · https://altkriz.github.io/aimaker/ | Fully client-side, CCv2. Full structural fields + System Prompt, PHI, Creator Notes, **custom extensions JSON editor**. Upload PNG/JPEG/WebP or auto-generate avatar; **decode any PNG card → fields → edit**; export JSON or PNG. MIT. | **Best architectural model for our editor**: client-side, PNG round-trip, extensions escape hatch. |
| **zoltanAI / AVAKson editor** | https://zoltanai.github.io/character-editor/ · https://avakson.github.io/character-editor | Standalone V1/V2 web editor. Cited by kingbri as the token tool — with the caveat: "This uses the OpenAI tokenizer. **Make sure to check tokens on SillyTavern!**" | Historic standalone editor. Tokenizer mismatch is a real trap for us too. (Note: `zoltanai.github.io/character-editor/` returned 404 to this session's fetcher.) |
| **Backyard AI** | https://backyard.ai/docs/creating-characters/character-prompt | Model Instructions, Display Name, Real Name, User Name, Character Persona, Your Persona, Scenario, Example Dialogue, First Message, Lorebook; `{Character}`/`{User}` vars; Grammars for output shaping. | **Lorebook hard-capped at 384 combined tokens, 4-message scan, no recursion, no overlapping entries** — a deliberately constrained design worth studying. |
| **WyvernChat** | https://wiki.wyvern.chat/en/Features/Character-Cards | Profile Photo, Name, Chat Name, Pronouns (5-slot custom), Outfits, Sprites, VRM 3D model, Bio, Background, Description, Example Scenes, Multi-Turn Example Dialogues, Character Notes, Scenario, First Message, Alt Greetings, System Prompt, Reinforcement Prompt, AI Image Prompt, Display Description, Lorebooks, Tags, Rating, Visibility. | **Ships an AI assistant ("Bob") that can edit any field, tags, alt greetings, and lexicon entries** — the most integrated AI editor found. "Bob never silently writes anything… shows you exactly what will change and waits for you to click Approve." Free tier page-local; paid cross-page/chat. |
| **Marinara Engine** | https://github.com/Pasta-Devs/Marinara-Engine | 36 first-party agents incl. a **Card Evolution Auditor**, **Lorebook Keeper**, AI lorebook maker; Card Browser imports from 6 sites; local-first, no account. | Alpha; sparse editor docs. |
| **Agnai** | https://github.com/agnaistic/agnai | Character creation + "Generate characters with AI" (feature list only); persona schema formats (W++, SBF, Boostyle, plaintext). | `docs.agnai.chat` NXDOMAIN — claims unverifiable here. |

### AI-assisted generators — "describe your character and I'll write the card"
This category is real and mature.

**In-editor assistants (highest integration):**
| Tool | URL | Shape |
|---|---|---|
| **WyvernChat "Bob"** | https://wiki.wyvern.chat/en/Paid/AI-Assistant | Edits any field with an approve-diff flow. Cannot touch Scripts/Commands/Secrets. |
| **ST Character Library AI Studio** | https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary (★140, pushed 2026-09-02) | Per-field wand button; multi-turn refinement; suggestion chips; word target; undo/redo; **highlight-revision** (rewrite only the selected span); per-field system-prompt overrides + saved presets; per-field context toggles; connection-profile picker; save-with-diff + auto-snapshot; AI tag suggestions; Lorebook Manager with **AI entry generation**. |
| **ST-Copilot** | https://github.com/Supker/ST-Copilot (★78) | OOC meta-assistant; AI lorebook manager with diff-review proposals; persistent scoped memory. |

**Whole-card generators:**
| Tool | URL | Notes |
|---|---|---|
| **CREC / SillyTavern-Character-Creator** | https://github.com/bmen25124/SillyTavern-Character-Creator (★180) | Runs on your ST **connection profiles** (BYOK). Can feed the LLM your existing character/lorebook data. Output formats XML/JSON/None. Ships a full card-writing guide as the default system prompt. FAQ edge over websites: "alternatives are just websites. This means you can't feed the AI with your ST character/lorebook data." |
| **CharGen v2** | https://huggingface.co/kubernetes-bad/chargen-v2 · https://chargen.kubes-lab.com | Purpose-trained Mistral-7B finetune generating **one field at a time** for partial re-rolls. Prompts: Description → "Expand it into a detailed description. Include details about character's personality, their outfit and figure."; Scenario → "Write an interesting and engaging scenario for roleplay between X and User."; Dialogue examples → "Write a few example exchanges… Separate each exchange with a `<START>` tag." Trained on ~16k hand-graded cards from a 140k scrape of Chub/Venus/JanitorAI (~800 hours of grading). Apache-2.0. |
| **ST-CardGen** | https://github.com/ewizza/ST-CardGen (★32) | **Short/Detailed/Verbose presets + per-field overrides**; per-field regeneration; fill-missing-fields-on-import; image providers (ComfyUI/SDAPI/KoboldCPP/Stability/HF/Imagen); keys via OS keychain. |
| **CharacterGen** | ★57, Python | Tag-based base prompts (`{{input}}`, `{{name}}`, `{{scenario}}`, `{{if_input}}…{{/if_input}}`); explicit generation order 1–6 with dependency handling; **cascading regeneration**; field-focus mode; multiple first messages → alternate greetings. |
| **cha1latte/sillytavern-character-generator** | https://github.com/cha1latte/sillytavern-character-generator (★58, MIT) | Not a tool — a *prompt file* you paste into Claude/GPT/Gemini/DeepSeek. Two budgets: Standard 600–1000 tokens; Small Model 400–600 for 7B–13B on 6–12GB VRAM. Emits V2 JSON with `{{char}}`/`{{user}}` already placed. |
| **charmaker** (★13), **cosmicdrunk/character-card-generator** (★3), **airole** (★127, "Start with Image"), **character-forge** (native Win+Android), **kobold-card-architect** (100% local, no keys), **SillyTavern-CreativeStudio** (★5, "one line (or nothing) → a complete, linked roleplay: card, openings, lorebook, preset, regex, Quick Replies, plus ComfyUI portraits") | GitHub | Long tail confirming demand. |
| **pookies.ai** | https://pookies.ai/create (402 to us) | Per CREC's FAQ it can "give a fandom website so it can analyze it" and has detailed fields like age/gender/running outfit. **The "paste a fandom URL" affordance is the strongest idea in this category.** |

**Card doctors / analyzers — the closest thing to a linter:**
- **Card Architect** (`vega-holdings/card_doctor`) — CCv2/CCv3/CHARX editor; per-field + global token counts via HF tokenizers; full CCv3 lorebook editor; autosave + version history; **LLM presets: tighten, convert-structured, convert-prose, enforce-style, generate-alts, generate-lore** with streaming diff; **Prompt Simulator** (Generic CCv3 / Strict CCv3 / CCv2-compat with token-budget drop policies); **Redundancy Detection**; **Lore Trigger Tester**.
- **Character-card-Analyzer** — scores slop/originality/tropes/cohesion/art-match; BYOK; installable PWA/APK.
- **CCEditor** (★42) — online v1/v2/v3 editor, Monaco, `?load_url=` direct card loading.
- **chub-png-card-editor** — edits `chara` **or** `ccv3` chunks, **preserves unknown `data` and top-level fields**, rewrites metadata without re-encoding pixels.
- **SillyInnkeeper** (★64) — local manager over thousands of PNG cards; full-text search across description/personality/scenario/first message/mes examples/creator notes/system prompts/PHI/alt greetings; filters by V1/V2/V3, token range, field presence, alt-greeting count; duplicate detection.
- **Writer's Workbench** (★30) — offline HTML card+lorebook builder with templates (main character, side character, scenario, locations, items, factions, history, concepts), location map builder, relationship graph.

### CharGen's dataset findings — the best primary evidence on what real cards get wrong
From ~16k graded cards (https://huggingface.co/kubernetes-bad/chargen-v2):
- "`{{char}} is Alice` renders into 'Alice is Alice'"
- "`the {{user}}` results in 'the Greg'"
- "Using both 'you' and '{{user}}' — results in model talking with 3 people: character, 'You' and Greg."
- "Short sentences that all start with character name or {{char}}. {{char}} is short. {{char}} is a boy. {{char}} likes milk."
- "Unbalanced `\"quotes\"` and `*emphasis*`"
- **Format mixing is endemic:** "Historically, there are just two dialog formats - Markdown and Novel… The mixed format, `*She says,* \"Promise!\"`, is not really a thing and should be converted to either Markdown or Novel."
- On AI-generated cards: "No obviously GPT-generated cards, as selected by GPTisms — that wastes tokens and is just bad. GPT3.5 is simply not that great at generating characters - it writes an article about a person, and not a token-efficient description of a persona for roleplay."

**That last point is the central design risk for an AI-assisted card maker: the failure mode of an LLM-written card is encyclopaedia prose, not bad facts.** Any generator we ship should be constrained toward dialogue/demonstration.

### What this means for our product
1. **Steal AiMaker's architecture** (client-side, PNG round-trip, extensions JSON) and CREC's model story (run on the user's own BYOK connection profile).
2. **Per-field generation with per-field re-roll** — CharGen v2's explicit rationale ("way less repetition issues and partial regenerations are a breeze"). Adopt ST-CardGen's Short/Detailed/Verbose presets.
3. **Show permanent vs temporary tokens as separate numbers**, with a per-turn projection.
4. **Ship a linter.** The known failure patterns are enumerable: `{{char}} is X`, `the {{user}}`, mixed Markdown/Novel format, unbalanced quotes/asterisks, unknown macros, negations, `{{user}}` actions in the greeting, GPTisms, instructions-in-description padding. Card Architect's Redundancy Detection and Prompt Simulator are the right feature shapes.
5. **Offer lorebook extraction** — an "this paragraph is permanent, move it to a keyed entry?" action. Highest-value optimisation in this domain; no existing tool does it automatically.
6. **Ship a Test-card mode** based on Joystick's battery (see §5.10).

---

## 5. Failure modes and workarounds

Verdict tags: **[MECH]** = follows from documented frontend/prompt behaviour; **[FOLK]** = community theory, not established.

### 5.1 The AI speaks/acts for `{{user}}` (impersonation / "AI breakthrough") **[MECH]**
The most-reported failure. NG names the cause: "at the core the 'AI' is really just a 'Text Completion Engine.' It really likes to copy what it did before."
**Workarounds, in order of efficacy:**
1. **Don't seed it.** Remove all `{{user}}` actions/dialogue from the greeting and examples. (NG, Trappu, Ali:Chat, JanitorAI docs — unanimous.)
2. **Fix the examples, not the prompt.** u/Pashax22, 2024-04-03: "Make sure they're good examples of how you want the model to respond — if you don't want the model to write for you, make sure they don't describe {{user}}'s speech or actions etc. Once you have 5 or 10 decent ones the problem should more or less disappear in my experience."
3. **Stopping strings.** u/BangkokPadang: `["\n{{user}}:","\n[{{user}}:","\nOOC: ","\n(OOC: ","\n### Input:",…]` — "just having the ones with {{user}} stops a lot of the outright speaking for me." ST also has "Names as Stop Strings" — "Recommended to keep it on to prevent model impersonation."
4. **Only then** the instruction, positively phrased. ST docs: "while *'Do not decide what {{user}} says or does'* is commonly included in prompts to prevent the AI from controlling your persona, some users find *'Write {{char}}'s responses in a way that respects {{user}}'s autonomy'* is more effective." NG: "Don't waste tokens putting *Don't respond for {{user}}* in the card if it's already in the NSFW or JB. The JB is the only place it belongs, and saying it 2-3 times won't make it any more likely to be followed."
5. If it persists it's the model: "the ultimate solution is to test models until you find one that doesn't do it too much."

User-side sentiment (r/CharacterAI 2025-08-18, u/fuckingretarded7291): "I swear I absolutely hate when bots start speaking for me AND make choice for me, it's genuinely annoying." Still current 2026-09-20: "The agony of watching the message just be a rewritten version of YOUR RESPONSE except ITS COMPLETELY OUT OF CHARACTER of your persona."

### 5.2 Negative prompting backfires **[MECH behaviour, FOLK mechanism]**
Near-universal consensus, endorsed by ST's own docs: "The AI will more easily follow instructions about what it should do than what it should not do… it's better to tell it how you want it to write instead."

NG's fix table:
- "Never jump off the cliff" → "Always stay on solid ground"
- "Don't try to make out with {{user}}" → "Always treat {{user}} as a platonic friend"

The clearest mechanistic writeup (r/SillyTavernAI 2025-07-10, u/uninchar, "Character Cards from a Systems Architecture perspective", https://safereddit.com/r/SillyTavernAI/comments/1lwmadx/): "when you write 'do not speak': 'Not' is weakly linked to almost every token… 'Speak' is a strong, concrete token the model can work with; The attention mechanism gets pulled toward 'speak' and related concepts; Result: The model focuses on speaking, the opposite of your intent." He offers pairs: "✗ '{{char}} doesn't trust easily' … ✓ '{{char}} verifies everything twice'." The author labels his own explanation "my best shot" — **[FOLK]** for the mechanism.
Hochi's softer rule: avoid contractions — "will not", "cannot"; "dislikes", "avoids", "hates" are fine.
*Dissent:* Ggoddkkiller argues the mechanism is chinese-whispers re-interpretation rather than negation-blindness, and that LLMs follow their own negative self-instructions fine. Practical advice is unchanged.

### 5.3 The card fights the model / description ignored **[MECH]**
The dominant current complaint is **assistant-format regression**. r/SillyTavernAI 2026-09-10, u/EquivalentStatus8830: "It feels like the model generates standard AI output first, then attempts to 'translate' it into character voice. The underlying content remains the exact same assistant slop… it just formats answers like an assistant with bullet points, breakdown lists, structured explanations and throws a few character quirks in it." u/sonofkarl gives the mechanism: "a lot of newer instruct models basically plan an assistant answer first (lists, 'it's not x it's y', tidy structure) and *then* put a cosplay hat on it. longer replies make it worse because **the helpfulness prior is stronger than the persona**." (https://safereddit.com/r/SillyTavernAI/comments/1wco8wj/)

Workarounds, verbatim from u/sonofkarl: "cut the system / jailbreak fluff that sounds like 'be a helpful assistant'. that wording invites the format you're fighting. put hard anti-patterns in the prompt: no bullet lists, no 'here's a breakdown', no meta coaching, reply in-character only. short and mean beats a paragraph of vibes. keep the character card *behavioral* … and move lore into keyword lorebook so the always-on prompt isn't a wiki."

**A diagnosable, non-model variant:** r/SillyTavernAI 2025-05-06, u/KainFTW: "Chat completion, for some reason, totally ignores the card description. No matter what model I'm using. While Text Completion takes the card description very much into consideration." Resolved in-thread by u/AetherNoble: "if character info is missing, maybe the 'Character Info' prompt template is disabled, so it's not actually feeding your character info to the model at all. TLDR … ALWAYS check the log to see what's the ground truth of what you're sending to the model." **A prompt inspector is a required feature.**

Other card-side causes:
- **Over-constraint → passivity.** NG's KISS: too many traits → "the LLM can't decide how to respond and defaults to 'helpful instruction' mode."
- **Contradictory traits.** Regular_Ad1368: "How can someone be toxic but also a sweetheart gentleman? You need to have that decided before you even get to writing." Fix is conditional: "{{char}} is rude to {{user}} when around others. When alone with {{user}}, {{char}}'s tone is gentler."
- **Too much scene furniture in the greeting.** In the canonical thread the diagnosis was the card, not the model: the greeting contained "man in finery… porters and servants, surrounding passengers, Lord Varner, Lady Varner, household guards, the player character and Willow all in one scene, so it's easy for a LLM to get confused. More specifically, it has Willow watching {{user}} having a conversation with Lord Varner passively in the intro, which can encourage it to take control." Removing the extra characters fixed it.
- **Ablate your preset first.** NG: blank the Main/NSFW/JB prompts and re-run. "I'll almost guarantee it runs differently. I've found a lot of the wrangling I was doing with the char card was due to overly aggressive pre/post prompts."
- **Instruction decay.** ST Prompts docs: "the AI assumes that all the messages in history were generated according to the rules in the *current* main prompt" — bad early messages poison the rest. ST: "Never let the AI 'get away' with something you don't want it to do."

### 5.4 Persona drift / personality decay over long chats **[MECH decay, FOLK numbers]**
u/Luganbro, 2026-09-05: "One issue that always creeps up past 40–50 messages is personality softening. Even with a well-defined persona, hostile or distant characters slowly drift toward becoming polite and overly cooperative. Re-injecting the full chat history doesn't fix it because recent agreeable turns end up setting the new tone for the LLM." u/NoiNeri: "This is usually a cumulative character 'drift' toward the model's default, average persona." (https://safereddit.com/r/SillyTavernAI/comments/1w85o6a/)

Mechanism: (1) recency/attention decay — the description sits at the top, so its influence falls as history grows; ST: "the AI assumes that the main prompt occurred in the distant past"; (2) sycophancy/positivity bias in instruction-tuned models.

**Workarounds:**
- **Re-inject the essence at low depth.** NoiNeri: "injecting a brief reminder of the character's desired traits closer to the bottom of the context." This is exactly Author's Note / Character's Note / PHI. ST: "The closer the Author's Note is to the bottom of the prompt, the more impact it has." Trappu: "**4 Is always the recommended value if you're unsure**." Chub: "Numbers between 1 and 5 are recommended."
- **Summarise + prune, preserving dialogue verbatim.** Ggoddkkiller's prompt: "Summarize only the necessary elements to coherently continue the Prior_Context, focusing on character interactions, dialogues, plot points … Write in detail and preserve dialogues exactly like they are while shortening narration." Rationale: "The strongest character nuance is dialogues not a bunch of traits or butchered summaries."
- **External state flags** for sticky traits so hostility isn't re-derived from agreeable recent turns. (This is our state tracker's job.)
- **Preserve voice, not personality prose.** GTurkistane, 2026-08-14: "Your characters stop being themselves when they no longer speak the way they are supposed to… the model will increasingly **infer** a character's personality from how they have spoken and behaved in the most recent messages… If you preserve the correct voice, speech patterns, vocabulary, tone, and mannerisms, the model is far more likely to infer and maintain the correct personality naturally." (https://safereddit.com/r/SillyTavernAI/comments/1vok730/)
- **Length in words, not tokens:** `[OOC: {{char}}'s replies should be approximately 300 words long.]` at Depth 0.
- **Caveat, and a genuine disagreement:** hammering the original personality at depth 0 "can sort of swing into the opposite problem and make them too static" (u/capybaraballs1995).

### 5.5 Character bleed **[MECH for injection leaks; FOLK for "provider memory"]**
Three senses:
1. **Cross-chat contamination.** u/Aggressive-Oil-8830, 2026-04-30: "one character is pulling context from another unrelated chat… Even in a fresh chat, the model still seems to 'bleed' behavior or scene context from another character/chat history." Accepted diagnosis in-thread (u/Diecron): "Almost certainly vector storage recalling memories." u/empire539: "Check prompt itemization / Prompt Inspector to see what exactly is being sent… If vector storage is enabled (and so, disable it)." (https://safereddit.com/r/SillyTavernAI/comments/1t00ave/)
2. **Voice bleed** inside one chat: u/Pastrugnozzo, 2026-02-04: "every character sounded like the same eloquent, slightly formal person wearing different hats. The villain monologues like the love interest. The gruff mercenary suddenly becomes poetic."
3. **Persona bleed into third parties**: u/Lohira_Wolf, 2026-07-22: "you mention a blacksmith in passing, and now your own character has to become the blacksmith, because there is nobody else on hand to play him."

**Card-side causes and fixes:**
- **`{{char}}` in multi-character cards is a bug.** Hochi: "don't use {{char}} anywhere if you have more than one character. I have one single instance of {{char}} in that card, and it's enough to make them sometimes think that they are some singular entity called Church of Love."
- **Group chats.** ST's "Join character cards" mode is a documented hazard: "due to how the typical character card is structured, the use of this mode can lead to unexpected behavior, including but not limited to: characters being confused about themselves, having merged personalities, uncertain traits, etc." Default mode "Swap character cards" includes only the active speaker — which causes the *opposite* problem (characters can't see each other). (https://docs.sillytavern.app/usage/characters/groupchats.md)
- **GTurkistane's "Vision" lorebook** fixes that: a Constant entry injected "at **Depth 3** as a **System** message" with each character's *visible* appearance, so everyone can see everyone. "Do not inject the entire character card at this depth. It can overshadow recent events and harm lore accuracy and continuity. Include only what other characters can currently observe."
- **A separate Narrator persona** for NPCs: "entire purpose is to be everyone who is not you or your character."

### 5.6 Looping **[MECH]**
Joystick's three causes:
1. "Scenario field is too strict, trapping your bot in a specific event."
2. "You've used words like 'Always' or 'Frequently' in your permanent tokens, and your model is taking it VERY literally… Consider conditionals (char will do X if Y) or more broad statements ('char is a vegetarian' instead of 'char only eats vegetables')."
3. "The bot has no personal goals or objectives and simply doesn't know what to do with itself and just keeps doing the same handful of things."
Ali:Chat: "If responses are looping, then decrease dialogue overlap, increase repetition penalty, or delete the looping text. Basically, the AI likes to create patterns."
AbsoluteTrash's goal fix: "give them things they want to accomplish that are bigger than what can be done in a single roleplay."

### 5.7 Passivity / "yes-bot" **[MECH]**
u/MagiNeko, 2026-02-07: "they eventually get bored. Not because the bot is bad, but because the bot is mostly reacting. If the user does not actively push the story, things start looping or losing momentum." u/fang_xianfu gives the mechanism: "LLMs are basically 'yes, and' machines. They double down on what's in the context. They're not going to 'decide' a monster attacks on their own, that idea has to be in the context already."
**Workarounds:** a scene-director/pacing block with explicit escalation triggers ("Static Dialogue… Emotional Plateau… Location Lock"); a "bold NPCs" block — verbatim from u/dptgreg, 2026-05-07: `<bold_npc> … Full_Execution: DO NOT output hesitant, partial, or incomplete actions. No_Hovering: NPCs NEVER just "reach for" or hover their hands. They fully grab, touch, and commit.`

### 5.8 Railroading greetings **[MECH]**
Same root cause as 5.1 plus the complementary complaint that the greeting **locks the scene**. u/knrdwn, 2026-05-04: "There is never an attempt to bring up a topic from the past… If a suggestion is made to go on a date and I propose a place, I've never heard 'I don't like that idea' or 'I have a better suggestion'."
Remedies: never write user actions; scenario = static world facts; end the greeting on a hook. The "no greeting at all" school deletes it and uses a one-line OOC scene seed: `[ Scene: Pardofelis is robbing {{user}}'s house; Tags: robbery, chase … ]`.
Note: railroading is also a legitimate tool. Advanced Card Writing Tricks: "with a little bit of railroading as a necessary evil, Impossible To Touch has shown that extraordinary results can be achieved" — via depth-keyed lorebook entries. The failure is *accidental* railroading in the greeting.

### 5.9 Adjective soup / trait lists without a causal engine **[MECH-ish]**
u/Ancient_Access_6738, 2026-09-18: "If the AI is given instead 'confident+quirky+tsundere+loud' it'll just give you full on slop. This is just trait soup, not a personality… MBTI, dere types, any shorthand to a personality type will end up producing tropes and what's worse — the character will react the same way to anything and everything." u/huge-centipede, 2026-01-27: "If you write … *[Personality: Bubbly, Shy]* The LLM is going to not enjoy that, and will have to confabulate (fabricate/gaslight itself) how these opposed traits connect with each other."
The 2025 Chinese-community retrospective on the XML-everything era: "It's like a student asking what to highlight in a textbook, and the teacher just highlights the whole book." (https://safereddit.com/r/SillyTavernAI/comments/1ke2i2f/)

### 5.10 Secrets the model shouldn't know yet — **community disagrees**
- **Hide it in invisible text.** `[](#'secret')` or `<!-- ... -->` — "Putting invisible text only in the greeting makes it easy for the user to never see it, since the two main causes of leaking invisible information are response streaming and editing." Caveat: "if you hide 'secret' information inside invisible text, it can still be viewed during response streaming and if the user edits character answers."
- **Don't give it the information at all.** GTurkistane: "If your plot contains a major secret or future twist, do **not** place it anywhere the LLM can see it… If the model must not use the information yet, do not give it the information yet."

### 5.11 Verification method — worth shipping as a "Test card" action
Joystick's battery:
- Remove the greeting; interview the character.
- `[Using the provided information, generate {{char}}'s last 10 google searches in list format.]`
- Reject the roleplay (walk away) — does the bot teleport you back?
- Speedrun the character's goals — do they react to achieving them?
- Do things they should hate / love — correct reactions?
- "Shooting the character in the head in the first message / Insist you're the character's long lost sibling / Offer the character an apple. If they say they would like it, take a bite out of the apple while staring them in the eyes."

---

## 6. Cross-guide disagreements (flag these; don't pick a side)

1. **W++/structured vs plaintext.** Against: NG, Hochi ("it works. No, you still shouldn't use it"), The Great Coom, the Chinese-community retrospective. Neutral/for: Moth ("it honestly doesn't really matter what format you use, just as long as you stay consistent"), eifersucht. ST docs decline to take a position.
2. **`{{char}}` vs literal name.** StatuoTW: "always use {{char}}". u/ginput: "The repeated use of `{{char}}` throughout the card is entirely unnecessary." Mechanically it costs the same tokens — the macro is substituted before the prompt is sent — so the real reason to use it is renaming/portability.
3. **Trait count.** AbsoluteTrash 15–20 vs NG KISS vs Hochi "one 'machiavellian' is worth three…".
4. **Where examples live.** Ali:Chat/Trappu/kingbri: in the Description (permanent, but `<START>` doesn't work there). ST docs + Joystick: in the Examples box (evictable, `<START>` works).
5. **`END_OF_DIALOG`.** r/CharacterAI recommends it; Joystick: "outdated and was never necessary." Not in any spec.
6. **Example dialogue: essential or harmful?** Trappu/Ali:Chat treat it as core. A strong counter-camp: u/Khadame "it's best to just ignore the example dialogue section"; u/Few-Frosting-4213 "Example dialog isn't really needed IMO". u/Moogs72: "there's really no community consensus."
7. **Is the first message the most important field?** u/Few-Frosting-4213: "a good first message is by far the most reliable predictor on how well the card will do." u/Moogs72: "I personally couldn't disagree more… the first message is important in defining the writing style of the chat, but does almost nothing toward defining the character."
8. **Token targets.** StatuoTW 400–700 permanent vs 2026 premium cards at 3.6k–8.1k, vs MVU-style RPG cards at "about 75000 tokens/reply on 2000th+ replies." Different eras and different goals, but the range is enormous.
9. **Does over-constraining kill creativity?** Stated as doctrine on both sides in the same preset release: "RolePlayer 1 … They love constraining the AI by the throat… **Roleplayer 1 needs Freaky Frankenstein MAX.** RolePlayer 2 … they believe constraining the AI decreases its creative ability… **RolePlayer 2 needs Freaky Frankenstein BOLT.**"
10. **Hiding secrets.** Invisible text vs not putting it in context at all.
11. **Lists vs prose.** u/Moogs72: "Some say that a character card 'must' be all straight prose, and others make them entirely of bulleted lists. LLMs can read both equally well"; u/MrNohbdy: "some models just handle one or the other better."
12. **Card or model at fault?** u/Prestigious_Bat4991: "The same character card, filtered through Claude vs Gemini, will ultimately come out as very different characters, and there's not much you can do to protect your character card against that."
13. **Jailbreaks in cards.** AbsoluteTrash and StatuoTW say no; most published cards embed them.

---

## 7. Source list

**Official docs**
- https://docs.sillytavern.app/usage/characters/characterdesign/ (lastmod 2026-07-09) · /usage/characters/ · /usage/prompts/ · /usage/prompts/context-template.md · /usage/prompts/prompt-manager.md · /usage/prompts/advancedformatting.md · /usage/prompts/tokenizer.md · /usage/worldinfo.md · /usage/characters/authors-note.md · /usage/characters/groupchats.md · /usage/faq.md
- https://docs.chub.ai/docs/the-basics/character-creation.md · /advanced-setups/prompting.md · /advanced-setups/lorebooks.md
- https://help.janitorai.com/en/article/the-basics-the-character-creation-page-overview-15xevon/ (2026-08-11) · /bot-creation-guide-w-images-by-faylua-8jcbw1/ (2025-05-09)
- https://backyard.ai/docs/creating-characters/character-prompt · https://wiki.wyvern.chat/en/Features/Character-Cards

**Specs**
- CCv1 + CCv2: https://github.com/malfoyslastname/character-card-spec-v2 (spec validated 2023-05-17; `{{original}}` added 2023-06-22)
- CCv3: https://github.com/kwaroran/character-card-spec-v3

**Community guides**
- https://rentry.co/alichat (AliCat, Ali:Chat v1.5)
- https://rentry.co/kingbri-chara-guide (kingbri, MinimALIstic; 1300→599 tokens)
- https://wikia.schneedc.com/bot-creation/trappu/creation · /post-creation · /intro (Trappu, PygmalionAI wiki)
- https://rentry.co/plists_alichat_avakson (AVAKSon; via Wayback 2024-12-09)
- https://rentry.org/NG_CharCard (NG)
- https://web.archive.org/web/20241219/https://rentry.org/MothsBotMakingStuff (Moth; live URL hijacked)
- https://web.archive.org/web/20230712205614/https://rentry.org/OnWritingCards (Hochi; pub 2022-12-14)
- https://rentry.co/absolutetrashs-bot-guide (AbsoluteTrash)
- https://rentry.co/Joystick_Tips (Joystick; pub 2024-01-12)
- https://rentry.org/AdvancedCardWritingTricks (anonymous; edited 2026-09-22)
- https://rentry.co/statuobotmakie (StatuoTW; updates to 2025-03-15)
- https://rentry.org/creating-a-bot (eifersucht) · https://rentry.org/TGCsCreativityGuide (The Great Coom, 2023-05-30)
- https://rentry.co/world-info-encyclopedia (kingbri/Alicat/Trappu) · https://rentry.org/meta_botmaking_list

**Reddit (via safereddit.com)**
- /17pp25a/ "Is 2500 tokens too much for one character?" (2023-11-07)
- /179brl9/ "I need to settle a debate. How many tokens…" (2023-10-16)
- /1506swd/ "How do you write proper example messages" (2023-07-15)
- /1anz4p1/ "About the dialogue examples" (2024-02-11) — the instruct-mode placement bug
- /1aq7k4l/ "Persona vs Personality vs Description" (2024-02-13)
- /1buwawz/ "Model Ignores Instructions" (2024-04-03)
- /18x4oie/ "Share your ways of making better characters" (2024-01-03)
- /1nd54s0/ "Should I reevaluate how I make character cards?" (2025-09-10)
- /1ke2i2f/ "The Evolution of Character Card Writing" (2025-05-03)
- /1lwmadx/ "Character Cards from a Systems Architecture perspective" (2025-07-10)
- /1vok730/ "After Three Years of Roleplaying in SillyTavern" (2026-08-14)
- /1w85o6a/ "Why long roleplay sessions always cause…" (2026-09-05)
- /1wco8wj/ assistant-format regression (2026-09-10)
- /1wf11qf/ "stop putting instructions in the description" (2026-09-13)
- /1wkxoz5/ "How do I make better character cards?" (2026-09-19)
- /1wjlq6g/ "How to go from making good cards to great ones" (2026-09-18)
- /1qopo7h/ "On building characters with friction" (2026-01-27)
- /1qvkkha/ voice bleed (2026-02-04) · /1t00ave/ cross-chat bleed (2026-04-30) · /1v3ukd3/ persona bleed (2026-07-22)
- /1qyeakp/ passivity (2026-02-07) · /1t3vuiw/ scene lock (2026-05-04) · /1t68afk/ bold NPCs (2026-05-07)
- /1tiopov/ example-dialogue leakage (2026-05-20) · /1c2kii2/ example-dialogue generation prompt (2024-04-12)
- /1pmjn2n/, /1t0d12m/, /1v1l6lz/, /1unlqrr/, /1ua6qno/, /1gakg7o/, /1sztr62/, /1kga41e/ — token and preset data points
- r/CharacterAI /1jol6sw/ (2025-04-01) · /1i49yyr/ (2025-01-18) · /1mtd7x3/ (2025-08-18) · /1wllpj9/ (2026-09-20)

**Tools**
- https://github.com/altkriz/aimaker · https://altkriz.github.io/aimaker/
- https://github.com/bmen25124/SillyTavern-Character-Creator
- https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary · https://github.com/Supker/ST-Copilot
- https://github.com/ewizza/ST-CardGen · https://github.com/rustyorb/SillyTavern-CreativeStudio
- https://huggingface.co/kubernetes-bad/chargen-v2 · https://chargen.kubes-lab.com
- https://github.com/cha1latte/sillytavern-character-generator
- https://github.com/kwaroran/RisuAI
- https://zoltanai.github.io/character-editor/ · https://avakson.github.io/character-editor
- https://likesumiink.substack.com/p/tuning-pre-existing-cards-for-texture

**Unreachable / dead (stated, not guessed)**
- The page titled "So you want to make a character" does not exist on docs.sillytavern.app (checked sitemap + llms.txt + direct 404 probes) nor anywhere else reachable. Closest real artifact is the PygmalionAI wiki intro: *"So, you want to start creating your own character card for PygmalionAI? Well have no fear fellow newcomer."* (https://wikia.schneedc.com/bot-creation/intro)
- `https://docs.sillytavern.app/usage/characters/character-design/` → 404 (canonical path is `/usage/core-concepts/characterdesign/`)
- `https://docs.chub.ai/docs/character-editor` → 404 confirmed; `chub.ai/`, `/characters/create`, `/create_lorebook`, `api.chub.ai/openapi.json` → 403; `chub.ai/blog` → 403
- `https://rentry.co/glubs-char-guide` → 404 (listed by Chub's docs but dead)
- `https://rentry.co/MothsBotMakingStuff` → live URL serves unrelated spam
- `https://pookies.ai/create` → 402; `docs.faraday.dev` / `docs.wyvern.chat` / `docs.risuai.net` / `docs.agnai.chat` → NXDOMAIN
- `api.pullpush.io` → HTTP 429 on every request this session (submission and comment endpoints, many query shapes)
- r/JanitorAI_Official is NSFW-gated on the Redlib mirror ("All posts are hidden because they are NSFW"), so Janitor-specific evidence here comes from r/SillyTavernAI threads that *discuss* Janitor cards.
