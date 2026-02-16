# Google Sheet Column Reference

## Your Current Sheet Layout

Based on your existing "Maison Fris Financials" Google Sheet:

```
Row 12+ (starting with STUSK):

A     | ... | I          | J           | K           | L            | M          | N           | O           | P
------|-----|------------|-------------|-------------|--------------|------------|-------------|-------------|------------
Ticker| ... | Buy Price 1| Buy Amount 1| Sell Price 1| Sell Amount 1| Buy Price 2| Buy Amount 2| Sell Price 2| Sell Amount 2
------|-----|------------|-------------|-------------|--------------|------------|-------------|-------------|------------
STUSK | ... | 450        | 200         | 500         | 100          | 440        | 50          | 520         | 25
SMG   | ... | 1000       | 125         | 1200        | 50           |            |             | 1250        | 25
$PVTC | ... | 100        | 15          | 125         | 10           | 95         | 5           | 130         | 5
```

## What Each Column Does

### Column A: Ticker
The stock symbol (STUSK, SMG, $PVTC, etc.)

### Columns I-L: Primary Tier (Tier 1)
- **I = Buy Price 1**: What you'll pay per share
- **J = Buy Amount 1**: Maximum shares you'll buy at this price
- **K = Sell Price 1**: What you'll sell for per share
- **L = Sell Amount 1**: Maximum shares you'll sell at this price

### Columns M-P: Secondary Tier (Tier 2) - Optional
- **M = Buy Price 2**: Alternative buy price (usually higher/lower for different qty)
- **N = Buy Amount 2**: Maximum shares at this tier
- **O = Sell Price 2**: Alternative sell price
- **P = Sell Amount 2**: Maximum shares at this tier

## How Customers See It

When someone opens the exchange, they see:

```
Ticker | Buy Offers          | Sell Offers         | Actions
-------|---------------------|---------------------|----------
STUSK  | 200 @ $450         | 100 @ $500         | [Buy] [Sell]
       | 50 @ $440          | 25 @ $520          |
SMG    | 125 @ $1000        | 50 @ $1200         | [Buy] [Sell]
       |                     | 25 @ $1250         |
$PVTC  | 15 @ $100          | 10 @ $125          | [Buy] [Sell]
       | 5 @ $95            | 5 @ $130           |
```

## Tips

### Only One Tier Needed?
Just fill columns I-L and leave M-P blank.

### Want to Stop Trading a Ticker?
Set all amounts (J, L, N, P) to 0 or blank.

### Need More Than 2 Tiers?
You can add more columns! Just update the config in index.html to include:
```javascript
buyPrice3: 16,    // Column Q
buyAmount3: 17,   // Column R
// etc...
```

### Quick Changes
Just edit the Google Sheet - changes appear when users refresh the orderbook page!
