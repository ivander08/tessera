-- Where a message row came from when it was not the model's own reply.
--
-- The prose guard writes a corrected version of an existing reply and adds it as a swipe
-- alternative. `active` already says which version is showing, but it cannot say that a
-- version was machine-edited rather than generated — and the reader needs that to know
-- which side of a swipe is theirs. NULL is every row written before this existed, and every
-- row the model writes from now on.
ALTER TABLE messages ADD COLUMN source TEXT;
