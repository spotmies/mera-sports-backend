-- Create Apartments Table
CREATE TABLE IF NOT EXISTS public.apartments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    pincode TEXT,
    locality TEXT,
    zone TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(name)
);

-- Enable RLS (Row Level Security) if needed, or leave open for now
ALTER TABLE public.apartments ENABLE ROW LEVEL SECURITY;

-- Allow read access to everyone (public)
CREATE POLICY "Allow public read access" ON public.apartments
    FOR SELECT USING (true);

-- Allow Admin/Service Role full access (implicit usually, but good to be explicit if needed)
-- Note: Service Role bypasses RLS, so this is mainly for authenticated users if any.
