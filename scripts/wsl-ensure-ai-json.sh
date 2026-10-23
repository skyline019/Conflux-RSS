#!/usr/bin/env bash
psql -d conflux -c "ALTER TABLE articles ADD COLUMN IF NOT EXISTS ai_json jsonb;"
psql -d conflux -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='articles' AND column_name='ai_json';"
