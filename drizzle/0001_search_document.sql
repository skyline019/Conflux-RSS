ALTER TABLE articles ADD COLUMN IF NOT EXISTS search_document text;
CREATE INDEX IF NOT EXISTS articles_search_document_gin
  ON articles USING gin (to_tsvector('simple', coalesce(search_document, '')));
