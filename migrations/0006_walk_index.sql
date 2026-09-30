-- The index the transcript walk actually needs.
--
-- `idx_messages_parent` is `(chat_id, parent_id, seq)`, which looks right and is not:
-- the walk asks for a node's ACTIVE child, and the planner could not satisfy `active = 1`
-- from that index. It fell back to `idx_messages_active` — `(chat_id, active, seq)` —
-- and scanned every active message in the chat at every step of the recursion. That made
-- the walk quadratic in the length of the conversation, and the transcript is walked on
-- every turn.
--
-- Measured on a linear chain, walking the whole path:
--
--     messages   idx_messages_parent   idx_messages_child
--     1,000                  49.1 ms              0.65 ms
--     5,000               1,417.6 ms              3.29 ms
--
-- 430x at five thousand messages, and the gap widens. With `active` in the index the
-- per-step lookup is a single seek instead of a scan.
--
-- `seq` stays last so the index also orders siblings, which is what a position needs when
-- the reader swipes. The old index is dropped rather than kept: it is a strict prefix of
-- this one, so it costs writes on every message and saves nothing.
DROP INDEX IF EXISTS idx_messages_parent;

CREATE INDEX IF NOT EXISTS idx_messages_child ON messages(chat_id, parent_id, active, seq);
