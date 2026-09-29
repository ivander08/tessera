-- Swipes, chub-shaped presets, and message lifecycle.
--
-- Three changes, all additive, none of which touch the append-only guarantee.

-- ---------------------------------------------------------------------------
-- 1. Swipes / alternatives
-- ---------------------------------------------------------------------------
--
-- A "position" in the conversation can hold several alternatives — swipe left and
-- right to pick one. Only the ACTIVE row is emitted into the prompt; the rest stay in
-- the table so swiping back is instant and free.
--
-- `swipe_group` groups the alternatives at one position. `active` marks the chosen
-- one. Both are needed rather than a single pointer: a group of one (every message
-- today) still has to be identifiable, and `active = 1` keeps the existing
-- `ORDER BY seq` walk valid — alternatives are ordered, but only one survives the
-- filter, so `seq` remains the sole ordering authority for what is actually sent.
--
-- Regenerating the LAST message therefore costs nothing in cache terms: every message
-- before it is byte-identical, so the provider's cached prefix still matches and only
-- the final slot is re-read. Editing an older message invalidates the prefix from that
-- point forward, which is inherent — the model saw something different.
ALTER TABLE messages ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE messages ADD COLUMN swipe_group TEXT;

-- The prompt builder's hot path: active rows for one chat, in order.
CREATE INDEX idx_messages_active ON messages(chat_id, active, seq);

-- ---------------------------------------------------------------------------
-- 2. Chub-shaped presets
-- ---------------------------------------------------------------------------
--
-- `knobs_json` holds sampler values (already imported from SillyTavern). Everything
-- else a chub preset carries — prompt structure, stopping strings, assistant prefill,
-- behaviour flags, lorebook scan settings — goes in `config_json`.
--
-- Two columns rather than one because the sources disagree: ST splits text-completion
-- from chat-completion namespaces and puts DRY/XTC in only one of them, while chub has
-- a single preset shape with a prompt structure attached. Keeping samplers separate
-- lets an ST import fill that half and leave the rest at defaults, which is what
-- "ST import as a subset" means in practice.
ALTER TABLE presets ADD COLUMN config_json TEXT;
ALTER TABLE presets ADD COLUMN updated_at INTEGER;

-- ---------------------------------------------------------------------------
-- 3. Chats remember which preset they use
-- ---------------------------------------------------------------------------
--
-- `chats.preset_id` has existed since 0000 and was never read. Nothing to add here —
-- recorded so the next reader knows it is now live rather than vestigial.
