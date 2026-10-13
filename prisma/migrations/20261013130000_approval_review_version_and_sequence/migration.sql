ALTER TABLE approval_requests ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE approval_requests ADD CONSTRAINT approval_content_version_positive CHECK (content_version > 0);
CREATE TABLE approval_request_daily_sequences (day TEXT PRIMARY KEY, value BIGINT NOT NULL CHECK(value > 0));

-- Exact monotonic generation, independent of timestamp precision. Any request update invalidates old views.
CREATE FUNCTION budu_advance_approval_content_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_version := OLD.content_version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_content_version_before_update BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION budu_advance_approval_content_version();

-- Protect effective attachment changes too, including pre-existing association paths.
-- This does not change attachment ownership/deletion rules (WFL-04/07 remain separate).
CREATE FUNCTION budu_advance_attachment_approval_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_id TEXT; current_id TEXT; request_id_to_update TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous_id := OLD.request_id; END IF;
  IF TG_OP <> 'DELETE' THEN current_id := NEW.request_id; END IF;
  IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  FOR request_id_to_update IN
    SELECT DISTINCT id FROM unnest(ARRAY[previous_id,current_id]) AS id WHERE id IS NOT NULL ORDER BY id
  LOOP
    UPDATE approval_requests SET content_version = content_version WHERE id = request_id_to_update;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_attachment_content_version AFTER INSERT OR UPDATE OR DELETE ON approval_attachments
  FOR EACH ROW EXECUTE FUNCTION budu_advance_attachment_approval_version();

-- Template interpretation and approval-rule changes invalidate views of affected requests too.
CREATE FUNCTION budu_advance_template_approval_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.schema IS DISTINCT FROM NEW.schema OR OLD.approver_rule IS DISTINCT FROM NEW.approver_rule OR OLD.name IS DISTINCT FROM NEW.name THEN
    UPDATE approval_requests SET content_version = content_version WHERE template_key = NEW.key;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_template_content_version AFTER UPDATE ON approval_templates
  FOR EACH ROW EXECUTE FUNCTION budu_advance_template_approval_version();
