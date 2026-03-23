# Kalshi Market Expansion Research

Research into which Kalshi prediction markets are most profitable to trade with the least possibility of manipulation.

## Evaluation Criteria

- **Manipulation resistance**: Can insiders front-run or influence outcomes?
- **Edge source**: What gives a quantitative trader an advantage?
- **Liquidity**: Can we deploy meaningful capital?
- **Settlement objectivity**: Is the outcome unambiguous?

## Tier 1: Best Fit (Objective Data, No Insider Edge)

### Weather (current)
- **Manipulation resistance**: Excellent — nobody controls the weather
- **Edge source**: Better NWS/GFS/ECMWF model interpretation than the market
- **Settlement**: NWS Daily Climate Reports from specific NOAA stations
- **Downside**: Low liquidity, seasonal (rain/snow markets dry up in spring)
- **Series**: KXHIGH*, KXLOW*, KXRAIN*, KXSNOW* (NY, LAX, DFW, IAH)

### Economics / Macro Data Releases
- **CPI (MoM/YoY)**, **Nonfarm Payrolls**, **Unemployment Rate**, **GDP**
- **Manipulation resistance**: Very strong — BLS/BEA data is embargoed, leaking is a federal crime. Settlement is purely objective
- **Edge source**: Better macro modeling, tracking real-time indicators (Cleveland Fed Nowcast for CPI, ADP for NFP, Atlanta Fed GDPNow for GDP)
- **Liquidity**: Much higher than weather — economics was historically Kalshi's biggest category before sports
- **Cadence**: Monthly (CPI, NFP) or quarterly (GDP) — fewer but higher-conviction trades
- **Potential series**: KXCPI, KXNFP, KXUNEMPLOYMENT, KXGDP

## Tier 2: Good Fit (Mostly Objective)

### Fed Funds Rate Decisions
- **Manipulation resistance**: Moderate-to-good. The Fed telegraphs via dot plots and speeches, so "insider info" is largely public. But Fed members occasionally leak
- **Edge source**: Better interpretation of Fed communications, macro modeling
- **Liquidity**: High around FOMC meetings

### Crypto Price Targets
- **Manipulation resistance**: Moderate — crypto can be manipulated by whales, but Kalshi settles on CF Benchmarks which are harder to game
- **Edge source**: Technical/on-chain analysis
- **Downside**: Essentially trading crypto with extra steps and worse liquidity

## Tier 3: Avoid (Insider/Manipulation Risk)

### Politics
- Insider knowledge from staffers, lobbyists, journalists
- SCOTUS decisions can leak
- Subjective resolution criteria on some contracts

### Entertainment/Awards
- Industry insiders, screener access, voter bloc knowledge
- Low-frequency events

### Sports
- Injury info, lineup decisions leak constantly
- 90%+ of Kalshi volume is sports — competing against sharp money and sportsbooks
- Extremely efficient market

### AI/Tech
- Corporate insiders know product launch timelines
- Subjective resolution on some contracts

## Recommendation: Economics/Macro Expansion

Economics/macro data releases are the best expansion opportunity because:

1. **Same bot architecture** — discovery -> estimation -> evaluation -> execution maps perfectly. Instead of weather forecasts, use macro nowcasts
2. **Higher liquidity** than weather, allowing more capital deployment
3. **Objective settlement** on government data — no subjectivity, no manipulation
4. **Complementary timing** — CPI/NFP are monthly events, weather is daily. They fill different slots
5. **Real-time indicators exist** — Cleveland Fed CPI Nowcast, Atlanta Fed GDPNow, ADP payrolls are the "weather models" equivalent
6. **Fed research validation** — A Federal Reserve research paper confirmed Kalshi's macro market distributions are well-calibrated, meaning mispricings exist but aren't wildly off — exactly where a quantitative edge pays off

## Kalshi Platform Stats (March 2026)

- 30-day rolling volume: $6.3 billion
- Open interest: ~$400 million
- 350,000+ active contracts
- Sports ~90% of volume, economics/politics/weather split the rest
- CFTC-regulated
