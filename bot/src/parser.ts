// Parsed webhook message type
export interface ParsedWebhookMessage {
  product: string;
  price: number;
  quantity: number;
  site: string;
  sku: string | null;
  mode: string | null;
  fulfillment_type: string | null;
  profile: string | null;
  order_id: string | null;
  order_email: string | null;
  order_link: string | null;
  account: string | null;
  raw_message_text: string;
}

/**
 * Parse StellarAIO webhook messages from Discord embeds.
 *
 * StellarAIO webhooks typically have:
 * - Title/header: "Successful Checkout" or similar
 * - Fields in format "FieldName\nValue" or as embed fields
 * - Multi-item checkouts with "Product (1)", "Price (1)", "Product (2)", etc.
 *
 * Required fields: Site, Product, Price, Qty
 * Optional fields: Mode, Fulfillment Type, SKU, Profile, Order ID, Order Email, Order Link, Account
 */

// Known field names that StellarAIO uses (case-insensitive matching)
const FIELD_MAPPINGS: Record<string, string> = {
  'site': 'site',
  'product': 'product',
  'price': 'price',
  'qty': 'quantity',
  'quantity': 'quantity',
  'sku': 'sku',
  'mode': 'mode',
  'fulfillment type': 'fulfillment_type',
  'fulfillment': 'fulfillment_type',
  'profile': 'profile',
  'order id': 'order_id',
  'order number': 'order_id',
  'order #': 'order_id',
  'order email': 'order_email',
  'email': 'order_email',
  'order link': 'order_link',
  'link': 'order_link',
  'account': 'account',
  'buy now atc?': 'mode',
  'buy now': 'mode',
};

// Fields that are per-item (can be numbered)
const PER_ITEM_FIELDS = new Set(['product', 'price', 'qty', 'quantity', 'sku']);

// Fields that are shared across all items in a checkout
const SHARED_FIELDS = new Set(['site', 'mode', 'fulfillment type', 'fulfillment', 'profile',
  'order id', 'order number', 'order #', 'order email', 'email', 'order link', 'link', 'account']);

interface EmbedField {
  name: string;
  value: string;
}

interface Embed {
  title?: string;
  description?: string;
  fields?: EmbedField[];
  author?: { name?: string };
}

/**
 * Check if a message/embed is a successful checkout notification
 */
export function isSuccessfulCheckout(embed: Embed | null, rawText: string): boolean {
  if (!embed && !rawText) return false;

  const textToCheck = [
    embed?.title || '',
    embed?.description || '',
    embed?.author?.name || '',
    rawText
  ].join(' ').toLowerCase();

  return textToCheck.includes('successful checkout') ||
         textToCheck.includes('checkout success') ||
         textToCheck.includes('successfully checked out');
}

/**
 * Parse a field name, handling numbered variants like "Product (1)"
 * Returns { baseName, index } where index is 0-based (null if not numbered)
 */
function parseFieldName(fieldName: string): { baseName: string; index: number } | null {
  const lower = fieldName.toLowerCase().trim();

  // Check for numbered fields like "Product (1)", "Price (2)"
  const numberedMatch = lower.match(/^([a-z\s]+?)\s*\((\d+)\)$/);
  if (numberedMatch) {
    const baseName = numberedMatch[1].trim();
    const index = parseInt(numberedMatch[2], 10) - 1; // Convert to 0-based
    if (FIELD_MAPPINGS[baseName] !== undefined) {
      return { baseName, index };
    }
  }

  // Direct match (non-numbered)
  if (FIELD_MAPPINGS[lower] !== undefined) {
    return { baseName: lower, index: 0 };
  }

  return null;
}

/**
 * Extract field value pairs from text content
 * Returns shared fields and per-item fields separately
 */
function extractFieldsFromText(text: string): {
  shared: Map<string, string>;
  items: Map<number, Map<string, string>>;
} {
  const shared = new Map<string, string>();
  const items = new Map<number, Map<string, string>>();

  // Split into lines and look for field names followed by values
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parsed = parseFieldName(line);

    if (parsed && i + 1 < lines.length) {
      const nextLine = lines[i + 1];

      // Make sure the next line isn't also a field name
      if (!parseFieldName(nextLine)) {
        const mappedName = FIELD_MAPPINGS[parsed.baseName];

        if (PER_ITEM_FIELDS.has(parsed.baseName)) {
          // Per-item field
          if (!items.has(parsed.index)) {
            items.set(parsed.index, new Map());
          }
          items.get(parsed.index)!.set(mappedName, nextLine);
        } else if (SHARED_FIELDS.has(parsed.baseName)) {
          // Shared field
          if (!shared.has(mappedName)) {
            shared.set(mappedName, nextLine);
          }
        }

        i++; // Skip the value line
      }
    }
  }

  // Also check for colon-separated format: "FieldName: Value"
  const colonPattern = /^([A-Za-z][A-Za-z0-9\s#?()]+?):\s*(.+)$/gm;
  let match;
  while ((match = colonPattern.exec(text)) !== null) {
    const fieldName = match[1].trim();
    const value = match[2].trim();
    const parsed = parseFieldName(fieldName);

    if (parsed && value) {
      const mappedName = FIELD_MAPPINGS[parsed.baseName];

      if (PER_ITEM_FIELDS.has(parsed.baseName)) {
        if (!items.has(parsed.index)) {
          items.set(parsed.index, new Map());
        }
        if (!items.get(parsed.index)!.has(mappedName)) {
          items.get(parsed.index)!.set(mappedName, value);
        }
      } else if (SHARED_FIELDS.has(parsed.baseName) && !shared.has(mappedName)) {
        shared.set(mappedName, value);
      }
    }
  }

  return { shared, items };
}

/**
 * Strip Discord spoiler tags (||text||) from a value
 */
function stripSpoilerTags(value: string): string {
  return value.replace(/^\|{2}(.+?)\|{2}$/s, '$1').trim();
}

/**
 * Parse price string to number
 */
function parsePrice(priceStr: string): number {
  const cleaned = stripSpoilerTags(priceStr)
    .replace(/[$£€¥]/g, '')
    .replace(/,/g, '')
    .replace(/\s*(USD|EUR|GBP|CAD|AUD)\s*/gi, '')
    .trim();

  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Parse quantity string to number
 */
function parseQuantity(qtyStr: string): number {
  const cleaned = qtyStr.replace(/[xX]/g, '').replace(/qty:?\s*/gi, '').trim();
  const parsed = parseInt(cleaned, 10);
  return isNaN(parsed) ? 1 : parsed;
}

/**
 * Parse a Discord message with StellarAIO webhook content
 * Returns an array of purchases (one per item in multi-item checkouts)
 */
export function parseWebhookMessage(embed: Embed | null, rawText: string): ParsedWebhookMessage[] {
  // Extract from embed fields first (highest priority)
  const embedShared = new Map<string, string>();
  const embedItems = new Map<number, Map<string, string>>();

  if (embed?.fields) {
    for (const field of embed.fields) {
      const parsed = parseFieldName(field.name);
      if (parsed) {
        const mappedName = FIELD_MAPPINGS[parsed.baseName];
        const value = field.value.trim();

        if (PER_ITEM_FIELDS.has(parsed.baseName)) {
          if (!embedItems.has(parsed.index)) {
            embedItems.set(parsed.index, new Map());
          }
          embedItems.get(parsed.index)!.set(mappedName, value);
        } else if (SHARED_FIELDS.has(parsed.baseName)) {
          embedShared.set(mappedName, value);
        }
      }
    }
  }

  // Extract from text
  const { shared: textShared, items: textItems } = extractFieldsFromText(rawText);

  // Merge: embed fields take priority
  const shared = new Map([...textShared, ...embedShared]);

  // Merge items
  const allItemIndices = new Set([...embedItems.keys(), ...textItems.keys()]);
  const items = new Map<number, Map<string, string>>();

  for (const idx of allItemIndices) {
    const merged = new Map([
      ...(textItems.get(idx) || new Map()),
      ...(embedItems.get(idx) || new Map())
    ]);
    items.set(idx, merged);
  }

  // If no numbered items found, treat as single item (index 0)
  if (items.size === 0) {
    items.set(0, new Map());
  }

  // Build purchase objects
  const purchases: ParsedWebhookMessage[] = [];

  for (const [_idx, itemFields] of [...items.entries()].sort((a, b) => a[0] - b[0])) {
    const product = stripSpoilerTags(itemFields.get('product') || '');
    const priceStr = itemFields.get('price') || '0';
    const qtyStr = itemFields.get('quantity') || '1';
    const sku = stripSpoilerTags(itemFields.get('sku') || '') || null;

    const site = stripSpoilerTags(shared.get('site') || '');

    // Skip if missing required fields
    if (!product || !site) {
      continue;
    }

    purchases.push({
      product,
      price: parsePrice(priceStr),
      quantity: parseQuantity(qtyStr),
      site,
      sku,
      mode: stripSpoilerTags(shared.get('mode') || '') || null,
      fulfillment_type: stripSpoilerTags(shared.get('fulfillment_type') || '') || null,
      profile: stripSpoilerTags(shared.get('profile') || '') || null,
      order_id: stripSpoilerTags(shared.get('order_id') || '') || null,
      order_email: stripSpoilerTags(shared.get('order_email') || '') || null,
      order_link: stripSpoilerTags(shared.get('order_link') || '') || null,
      account: stripSpoilerTags(shared.get('account') || '') || null,
      raw_message_text: rawText,
    });
  }

  return purchases;
}

/**
 * Get a summary of what was parsed for logging
 */
export function getParseDebugInfo(parsed: ParsedWebhookMessage): string {
  const fields = [
    `Product: ${parsed.product}`,
    `Price: $${parsed.price}`,
    `Qty: ${parsed.quantity}`,
    `Site: ${parsed.site}`,
  ];

  if (parsed.sku) fields.push(`SKU: ${parsed.sku}`);
  if (parsed.order_id) fields.push(`Order ID: ${parsed.order_id}`);

  return fields.join(' | ');
}
