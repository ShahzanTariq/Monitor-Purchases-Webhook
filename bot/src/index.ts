import { Client, GatewayIntentBits, Message, PartialMessage, Embed } from 'discord.js';
import dotenv from 'dotenv';
import path from 'path';
import { isSuccessfulCheckout, parseWebhookMessage, getParseDebugInfo } from './parser';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const USER_API_TOKEN = process.env.USER_API_TOKEN;
const API_URL = process.env.API_URL || 'http://localhost:3001' || 'https://resell-tracker.com/api/v1' || 'http://127.0.0.1:3001';

if (!DISCORD_BOT_TOKEN) {
  console.error('Error: DISCORD_BOT_TOKEN is required in .env file');
  process.exit(1);
}

if (!DISCORD_CHANNEL_ID) {
  console.error('Error: DISCORD_CHANNEL_ID is required in .env file');
  process.exit(1);
}

if (!USER_API_TOKEN) {
  console.error('Error: USER_API_TOKEN is required in .env file');
  console.error('Create an API token in the Resell Tracker Settings page');
  process.exit(1);
}

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Track processed message IDs to avoid duplicates within session
const processedMessages = new Set<string>();

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
  try {
    const response = await fetch(`${API_URL}/bot/purchases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Token': USER_API_TOKEN!,
      },
      body: JSON.stringify(purchase),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));

      // Check if it's a duplicate (409 Conflict)
      if (response.status === 409) {
        console.log(`[SKIP] Purchase already exists: ${purchase.discord_message_id}`);
        return false;
      }

      // Check for auth errors
      if (response.status === 401) {
        console.error('[ERROR] Invalid API token. Please check your USER_API_TOKEN');
        return false;
      }

      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return true;
  } catch (error) {
    console.error('[ERROR] Failed to insert purchase:', error);
    return false;
  }
}

async function processMessage(message: Message | PartialMessage): Promise<void> {
  // Ignore messages from other channels
  if (message.channelId !== DISCORD_CHANNEL_ID) return;

  // Skip if we've already processed this message in this session
  if (processedMessages.has(message.id)) {
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

  // Mark message as processed
  processedMessages.add(message.id);

  // Insert each item into database via API
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
  console.log(`API URL: ${API_URL}`);
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
