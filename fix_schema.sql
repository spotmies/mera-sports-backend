-- Add the 'is_document_required' column to the 'events' table
-- This fixes the "Could not find the 'is_document_required' column" error.

ALTER TABLE events 
ADD COLUMN is_document_required BOOLEAN DEFAULT FALSE;

-- Note: After running this, if the error persists, 
-- please reload the Schema Cache in your Supabase Dashboard settings.
