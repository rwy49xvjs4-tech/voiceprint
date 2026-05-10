// api/webhook.js
// Stripe calls this URL automatically after every payment
// It upgrades the user's plan in Supabase so they get Pro access instantly

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // Service key (not anon) — has full DB access
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify the request actually came from Stripe (security check)
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // req.body must be the raw body — Vercel handles this automatically
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Handle the events we care about
  switch (event.type) {

    // ── Payment succeeded → upgrade to Pro ──────────────────────
    case 'checkout.session.completed': {
      const session = event.data.object;
      const email = session.customer_details?.email;
      const plan = session.metadata?.plan || 'pro'; // 'monthly' or 'annual'

      if (email) {
        // Find user by email and upgrade their plan
        const { error } = await supabase
          .from('profiles')
          .update({
            plan: 'pro',
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            plan_type: plan, // monthly or annual
            plan_started_at: new Date().toISOString()
          })
          .eq('email', email);

        if (error) console.error('Supabase update error:', error);
        else console.log('Upgraded to Pro:', email);
      }
      break;
    }

    // ── Subscription cancelled → downgrade to Free ──────────────
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      const { error } = await supabase
        .from('profiles')
        .update({
          plan: 'free',
          stripe_subscription_id: null,
          plan_type: null
        })
        .eq('stripe_customer_id', customerId);

      if (error) console.error('Downgrade error:', error);
      else console.log('Downgraded to Free, customer:', customerId);
      break;
    }

    // ── Payment failed → notify but keep access for grace period ─
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      console.log('Payment failed for customer:', invoice.customer);
      // You can add email notification logic here later
      break;
    }

    default:
      // Ignore other events
      break;
  }

  // Always return 200 to Stripe so it knows we received it
  return res.status(200).json({ received: true });
}

// Tell Vercel not to parse the body — Stripe needs the raw bytes to verify the signature
export const config = {
  api: {
    bodyParser: false
  }
};
