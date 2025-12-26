-- Backfill existing users with 'Male'
UPDATE public.users 
SET gender = 'Male' 
WHERE gender IS NULL;
