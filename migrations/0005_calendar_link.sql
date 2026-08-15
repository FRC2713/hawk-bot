-- Direct link to the event on Google Calendar (its `htmlLink`), surfaced in
-- Calendar Change Handling's edited-notification thread reply. Null for
-- manual test Events (see ADR-0002) and for anything synced before this
-- column existed.
ALTER TABLE events ADD COLUMN calendar_link TEXT;
