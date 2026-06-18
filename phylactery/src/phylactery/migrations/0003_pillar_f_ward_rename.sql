-- Pillar F: rename identity category 'user' → 'ward'.
-- This is the one-time rename point. All new records use 'ward'.
UPDATE identity_files SET category = 'ward' WHERE category = 'user';
