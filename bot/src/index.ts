import { Client, GatewayIntentBits, Message, PartialMessage, Embed } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { isSuccessfulCheckout, parseWebhookMessage, getParseDebugInfo } from './parser';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!DISCORD_BOT_TOKEN) {
  console.error('Error: DISCORD_BOT_TOKEN is required in .env file');
  process.exit(1);
}

if (!DISCORD_CHANNEL_ID) {
  console.error('Error: DISCORD_CHANNEL_ID is required in .env file');
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_ANON_KEY are required in .env file');
  process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function checkExists(discordMessageIdPattern: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('purchases')
    .select('id')
    .like('discord_message_id', discordMessageIdPattern)
    .limit(1);

  if (error) {
    console.error('Error checking existence:', error);
    return false;
  }

  return data && data.length > 0;
}

async function insertPurchase(purchase: {
  product: string;
  sku: string | null;
  price: number;
  quantity: number;
  site: string;
  order_id: string | null;
  order_email: string | null;
  order_link: string | null;
  mode: string | null;
  fulfillment_type: string | null;
  profile: string | null;
  account: string | null;
  purchase_date: string;
  raw_message_text: string;
  discord_message_id: string;
}): Promise<boolean> {
  const { error } = await supabase
    .from('purchases')
    .insert(purchase);

  if (error) {
    // Check if it's a unique constraint violation (already exists)
    if (error.code === '23505') {
      console.log(`[SKIP] Purchase already exists: ${purchase.discord_message_id}`);
      return false;
    }
    throw error;
  }

  return true;
}

async function processMessage(message: Message | PartialMessage): Promise<void> {
  // Ignore messages from other channels
  if (message.channelId !== DISCORD_CHANNEL_ID) return;

  // Skip if we've already processed this message (check for base ID or any item from it)
  const exists = await checkExists(`${message.id}%`);
  if (exists) {
    console.log(`[SKIP] Already processed message ${message.id}`);
    return;
  }

  // Build raw text from message content and embeds
  const rawTextParts: string[] = [];
  if (message.content) {
    rawTextParts.push(message.content);
  }

  // Process embeds
  let embed: Embed | null = null;

  for (const msgEmbed of message.embeds) {
    // Build raw text representation
    if (msgEmbed.title) rawTextParts.push(msgEmbed.title);
    if (msgEmbed.description) rawTextParts.push(msgEmbed.description);
    if (msgEmbed.author?.name) rawTextParts.push(msgEmbed.author.name);
    if (msgEmbed.fields) {
      for (const field of msgEmbed.fields) {
        rawTextParts.push(`${field.name}\n${field.value}`);
      }
    }

    // Convert to our simplified embed format
    embed = {
      title: msgEmbed.title || undefined,
      description: msgEmbed.description || undefined,
      author: msgEmbed.author ? { name: msgEmbed.author.name || undefined } : undefined,
      fields: msgEmbed.fields?.map(f => ({ name: f.name, value: f.value })),
    } as Embed;
  }

  const rawText = rawTextParts.join('\n');

  // Check if this is a successful checkout message
  if (!isSuccessfulCheckout(embed as { title?: string; description?: string; fields?: { name: string; value: string }[]; author?: { name?: string } } | null, rawText)) {
    console.log(`[SKIP] Not a checkout message: ${message.id} - "${rawText.slice(0, 50)}..."`);
    return;
  }

  // Parse the webhook message (returns array for multi-item checkouts)
  const parsedItems = parseWebhookMessage(
    embed as { title?: string; description?: string; fields?: { name: string; value: string }[]; author?: { name?: string } } | null,
    rawText
  );

  if (parsedItems.length === 0) {
    console.log(`[SKIP] Could not parse required fields from message ${message.id}`);
    console.log(`  Raw text: ${rawText.slice(0, 200)}...`);
    return;
  }

  // Insert each item into database
  const purchaseDate = message.createdAt?.toISOString() || new Date().toISOString();
  let savedCount = 0;

  for (let i = 0; i < parsedItems.length; i++) {
    const parsed = parsedItems[i];
    // Use message_id with item index for uniqueness (e.g., "123456789_0", "123456789_1")
    const discordMessageId = parsedItems.length > 1 ? `${message.id}_${i}` : message.id;

    try {
      const inserted = await insertPurchase({
        product: parsed.product,
        sku: parsed.sku,
        price: parsed.price,
        quantity: parsed.quantity,
        site: parsed.site,
        order_id: parsed.order_id,
        order_email: parsed.order_email,
        order_link: parsed.order_link,
        mode: parsed.mode,
        fulfillment_type: parsed.fulfillment_type,
        profile: parsed.profile,
        account: parsed.account,
        purchase_date: purchaseDate,
        raw_message_text: rawText,
        discord_message_id: discordMessageId,
      });

      if (inserted) {
        savedCount++;
        console.log(`[SUCCESS] Saved purchase ${i + 1}/${parsedItems.length}: ${getParseDebugInfo(parsed)}`);
      }
    } catch (error) {
      console.error(`[ERROR] Failed to save purchase ${i + 1}:`, error);
    }
  }

  if (savedCount > 0) {
    console.log(`[DONE] Saved ${savedCount} item(s) from message ${message.id}`);
  }
}

client.once('ready', () => {
  console.log(`Discord bot logged in as ${client.user?.tag}`);
  console.log(`Listening to channel: ${DISCORD_CHANNEL_ID}`);
});

client.on('messageCreate', (message) => {
  processMessage(message);
});

// Also process message updates (in case webhook edits)
client.on('messageUpdate', (_oldMessage, newMessage) => {
  if (newMessage.partial) return;
  processMessage(newMessage);
});

client.login(DISCORD_BOT_TOKEN).catch((error) => {
  console.error('Failed to login to Discord:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  client.destroy();
  process.exit(0);
});
