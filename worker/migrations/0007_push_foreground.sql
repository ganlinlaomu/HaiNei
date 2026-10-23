-- While the app is on screen it receives messages and calls over its own
-- relay connection; a push would only cover it with a system banner.
-- The app reports its foreground state; pushes skip a device until this time.
ALTER TABLE hainei_push_subscriptions ADD COLUMN foreground_until INTEGER NOT NULL DEFAULT 0;
