-- Add 'gender' column to public.users table
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS gender TEXT;

-- Optional: Add check constraint to ensure valid values (Male, Female, Other)
-- ALTER TABLE public.users ADD CONSTRAINT check_gender CHECK (gender IN ('Male', 'Female', 'Other'));
