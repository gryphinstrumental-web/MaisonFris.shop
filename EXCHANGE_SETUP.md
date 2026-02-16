# Pavian Exchange Setup Guide

## Overview
Your stock exchange is now integrated into your website and uses your **existing Google Sheet**! The system supports **tiered pricing** so you can offer different quantities at different prices.

## 1. Your Existing Google Sheets Structure

✅ **Good news!** Your sheet is already set up correctly. The code is configured to read from:

### Column Layout (what you already have):
- **Column A**: Ticker (STUSK, SAI, SACQR, etc.)
- **Columns I-L**: Tier 1 Pricing
  - Column I: Buy Price 1
  - Column J: Buy Amount 1
  - Column K: Sell Price 1
  - Column L: Sell Amount 1
- **Columns M-P**: Tier 2 Pricing
  - Column M: Buy Price 2
  - Column N: Buy Amount 2
  - Column O: Sell Price 2
  - Column P: Sell Amount 2

### How Tiered Pricing Works

You can set **different prices for different quantities** to control demand:

**Example for STUSK:**
- **Tier 1**: Sell 100 shares @ $500 each
- **Tier 2**: Sell 50 shares @ $520 each (higher price, lower quantity)

This lets you:
- Offer bulk discounts
- Limit high-demand shares
- Create scarcity for premium pricing

### Your Sheet is Already Published
Your Sheet ID is: `11qXad6yFmjAsQ1PdMAD4Ww2N7154mSyUXFJksAz43I`

Make sure it's published to web:
1. Click **File → Share → Publish to web**
2. Choose **Entire Document**
3. Click **Publish**

## 2. How to Set Your Prices

Simply edit your Google Sheet! Here's how:

### For Each Ticker:

**Tier 1 (Columns I-L)** - Your primary pricing:
- Set the **Buy Price** (I): What you'll pay per share
- Set the **Buy Amount** (J): How many you'll buy at this price
- Set the **Sell Price** (K): What you'll sell for per share
- Set the **Sell Amount** (L): How many you'll sell at this price

**Tier 2 (Columns M-P)** - Optional secondary pricing:
- Set different prices/quantities for additional flexibility
- Leave blank if you only want one tier

### Examples:

**Scenario 1: Simple single-tier pricing**
- Ticker: STUSK
- Buy Price 1: $450, Buy Amount 1: 200
- Sell Price 1: $500, Sell Amount 1: 100
- (Leave Tier 2 blank)

**Scenario 2: Tiered pricing to control demand**
- Ticker: SMG
- Buy Price 1: $1000, Buy Amount 1: 100 ← Lower price, higher qty
- Buy Price 2: $900, Buy Amount 2: 25 ← Higher price, lower qty
- Sell Price 1: $1200, Sell Amount 1: 50
- (Sell Tier 2 blank)

**Scenario 3: Different tiers for buy AND sell**
- Ticker: $PVTC
- Tier 1: Buy $100/100 shares, Sell $125/50 shares
- Tier 2: Buy $95/25 shares, Sell $130/25 shares

## 3. Discord Webhook Setup

### Create Webhook
1. Open your Discord server
2. Go to **Server Settings → Integrations → Webhooks**
3. Click **New Webhook**
4. Name it "Pavian Exchange" (or anything you like)
5. Choose the channel where you want order notifications
6. Click **Copy Webhook URL**

### Add Webhook to Your Site

Open [index.html](index.html) and find the `CONFIG` object (around line 483):

```javascript
discordWebhook: 'YOUR_DISCORD_WEBHOOK_URL_HERE'
```

Replace `YOUR_DISCORD_WEBHOOK_URL_HERE` with your actual webhook URL.

## 4. Test It Out

1. Open your website in a browser
2. Click the **hamburger menu** (top left)
3. Click **"Pavian Exchange Orderbook"**
4. You should see your equities with tiered pricing displayed
5. Click a **Buy** or **Sell** button
6. Select a price tier (if multiple available)
7. Fill out the form and submit
8. Check your Discord channel for the order notification!

## Order Flow

1. **Customer views orderbook** → Sees all available tickers with tiered pricing
2. **Customer selects tier** → Chooses which price/quantity tier they want
3. **Customer fills form** → Enters Discord username, Minecraft IGN, quantity, notes
4. **Discord notification sent** → You receive a formatted embed with all order details
5. **Manual confirmation** → You confirm/negotiate with customer via Discord
6. **Complete transaction** → Handle the trade in-game
7. **Update sheet** → Adjust quantities in your Google Sheet as needed

## Controlling Your Market

### Dynamic Pricing Strategies

**Create scarcity:**
- Tier 1: 100 shares @ $10 (bulk discount)
- Tier 2: 25 shares @ $12 (premium for small orders)

**Limit exposure:**
- Only sell small quantities at favorable prices
- Force larger orders to higher price tiers

**Market making:**
- Set narrow spreads for liquid assets
- Set wide spreads for illiquid/risky assets

### Live Updates

Just edit your Google Sheet and refresh the exchange page! Changes appear immediately:
- Update prices
- Adjust quantities
- Add/remove tiers (just clear the cells)
- Add new tickers

## Troubleshooting

### "Error loading equities"
- Make sure your Google Sheet is **published to web**
- Check that Sheet ID is correct: `11qXad6yFmjAsQ1PdMAD4Ww2N7154mSyUXFJksAz43I`
- Verify the sheet name is "Sheet1"

### "Order not appearing in Discord"
- Verify your webhook URL is correct
- Make sure the webhook hasn't been deleted
- Check browser console for errors (F12)
- Test the webhook with a Discord webhook tester

### Tiers not showing correctly
- Make sure your price/amount cells have numbers (not text)
- Empty cells or "0" amounts will hide that tier
- Check columns I-P are formatted as numbers

### Ticker not appearing
- Data starts at row 12 (STUSK)
- Make sure ticker is in column A
- Row must have at least one tier with price AND quantity > 0

## Security Notes

- The Discord webhook URL should be kept private
- Anyone with the webhook can send messages to your channel
- Consider using a private channel for order notifications
- The Google Sheet must be public for this to work (no sensitive data!)

## Customization

Want to add more features? You can:
- Add more columns to your sheet (e.g., "Last Trade", "Market Cap")
- Customize the Discord embed colors/format
- Add order validation or limits
- Add a transaction history section

Enjoy your exchange! 🎉
