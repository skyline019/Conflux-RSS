ALTER TABLE articles ADD COLUMN IF NOT EXISTS resolved_link text;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS video_url text;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS media jsonb NOT NULL DEFAULT '[]'::jsonb;
