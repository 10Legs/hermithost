-- Fires after every CREATE/ALTER TABLE during Coolify migrations.
-- Once the `teams` table exists, inserts the root team (id=0) that
-- Coolify's seeder expects to already exist when it inserts
-- shared_environment_variables with team_id=0.
CREATE OR REPLACE FUNCTION ensure_root_team()
RETURNS event_trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'teams'
  ) THEN
    BEGIN
      INSERT INTO teams (id, name, personal_team, created_at, updated_at)
      SELECT 0, 'root', false, NOW(), NOW()
      WHERE NOT EXISTS (SELECT 1 FROM teams WHERE id = 0);
    EXCEPTION WHEN OTHERS THEN
      NULL; -- ignore: table may not yet have all columns
    END;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE EVENT TRIGGER ensure_root_team_trigger
ON ddl_command_end
WHEN TAG IN ('CREATE TABLE', 'ALTER TABLE')
EXECUTE FUNCTION ensure_root_team();
