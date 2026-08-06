-- The waitlist. One row per address, and that is the whole schema.
--
-- `email` is the PRIMARY KEY rather than an autoincrement id with a UNIQUE
-- index on top, because the only question ever asked of this table is "is this
-- address already here". Making the address itself the key means a resubmit is
-- an ON CONFLICT DO NOTHING no-op instead of a duplicate row to clean up later,
-- and it means the endpoint can answer identically either way -- which is what
-- stops it being usable to probe whether an address is on the list.
--
-- `created_at` is unix seconds, not a datetime string: it sorts correctly as an
-- integer and needs no parsing to compare. Read it back with
-- datetime(created_at,'unixepoch').
--
-- `source` records which surface the address came from, so a later landing page
-- or an in-popup link can be told apart from the apex form without a migration.
CREATE TABLE IF NOT EXISTS waitlist (
  email      TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL,
  source     TEXT
);

CREATE INDEX IF NOT EXISTS waitlist_created_at ON waitlist (created_at DESC);
