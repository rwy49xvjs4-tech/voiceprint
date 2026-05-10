-- Run this in your Supabase SQL Editor
-- Adds the Stripe columns needed for payment tracking

alter table profiles
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists plan_type text,
  add column if not exists plan_started_at timestamp;

-- Index for fast Stripe customer lookups
create index if not exists idx_profiles_stripe_customer
  on profiles (stripe_customer_id);

-- Index for fast email lookups (used by webhook)
create index if not exists idx_profiles_email
  on profiles (email);
