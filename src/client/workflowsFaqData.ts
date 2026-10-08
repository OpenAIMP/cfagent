export interface FaqExecutionMethod {
  name: string;
  badge: string;
  badgeColor: "blue" | "green" | "purple" | "orange";
  description: string;
  actionSteps: string[];
  samplePayloadOrCommand?: string;
  targetTab?: string;
}

export interface FaqQuestionItem {
  id: string;
  number: number;
  question: string;
  category: "opportunities" | "budget-risk" | "chance-return" | "combinations" | "liquidity" | "directional" | "defined-risk" | "least-risk";
  categoryLabel: string;
  summary: string;
  theoreticalContext: string;
  mathematicalBasis?: string;
  methods: FaqExecutionMethod[];
  primaryWorkflow: string;
  secondaryWorkflow: string;
  keyParameters: string;
  optimalOutputStructure: string;
  targetTab: string;
  samplePrompt: string;
}

export interface WorkflowImprovementItem {
  id: string;
  number: number;
  title: string;
  currentLimitation: string;
  proposedEnhancement: string;
  impact: string;
  targetComponents: string[];
}

export interface CapabilityMatrixRow {
  question: string;
  primaryWorkflow: string;
  secondaryWorkflow: string;
  keyInputParameter: string;
  optimalOutputStructure: string;
  targetTab: string;
}

export const FAQ_QUESTIONS: FaqQuestionItem[] = [
  {
    id: "best-opportunities",
    number: 1,
    question: "Find me the best opportunities / recommend me the best opportunities",
    category: "opportunities",
    categoryLabel: "Opportunity Ranking",
    summary: "Ranks multi-leg strategies by a multivariate composite score balancing Expected Value (EV), win rate (POP), bid-ask liquidity, and net theta yield.",
    theoreticalContext: "The platform evaluates opportunities using a Multivariate Composite Opportunity Score (S_composite ∈ [0, 100]) weighted across five dimensions:\n\nS_composite = w_thesis * S_thesis + w_EV * S_EV + w_POP * S_POP + w_liq * S_liq + w_theta * S_theta\n\nWhere S_EV is Risk-adjusted Expected Value (Return on Risk vs Collateral at Risk), S_POP is Probability of Profit calculated via Black-Scholes cumulative log-normal distribution N(d2), S_liq is bid-ask spread tightness and open interest depth, and S_theta is positive time decay yield versus negative carry burden.",
    mathematicalBasis: "EV = (POP * MaxProfit) - ((1 - POP) * MaxLoss) / Collateral",
    methods: [
      {
        name: "Method A: Strategy Discovery Engine (Visual UI)",
        badge: "Discovery Engine",
        badgeColor: "blue",
        description: "Navigate to Auto Options Research → 🎯 Strategy Discovery & Payoff Analyzer. Enter ticker (e.g. NVDA), select sentiment (Bullish, Bearish, or Neutral), and leave Optimization Slider at 50% (Balanced EV).",
        actionSteps: [
          "Open Auto Options Research → 🎯 Strategy Discovery.",
          "Input underlying symbol (e.g. NVDA, TSLA, or SPY).",
          "Set sentiment to 'Bullish' or 'Neutral' and leave bias at 50%.",
          "The engine evaluates all 72 catalog strategies and pins the #1 composite scored setup at the top.",
        ],
        samplePayloadOrCommand: 'discoverStrategies({ symbol: "NVDA", sentiment: "bullish", optimizationBias: 50 })',
        targetTab: "trading",
      },
      {
        name: "Method B: Natural Language Query (NLQ / Chat)",
        badge: "Conversational Agent",
        badgeColor: "green",
        description: "Use the omni-command bar or chat drawer to prompt the agent directly. The multi-agent orchestrator triggers bestTrade optimization mode.",
        actionSteps: [
          "Open the Chat drawer or platform command bar.",
          "Prompt: 'Recommend me the best options opportunities on NVDA' or 'Find top scoring trades on TSLA'.",
          "The orchestrator parses implied volatility percentile, runs Black-Scholes scoring, and displays the top candidate card.",
        ],
        samplePayloadOrCommand: "Recommend me the best options opportunities on NVDA",
        targetTab: "chat",
      },
      {
        name: "Method C: Scheduled Opportunity Scanner (Background Automation)",
        badge: "Durable Timers",
        badgeColor: "purple",
        description: "Configure an autonomous background scan in Auto Options Research → ⏰ Scheduled Screening. Cloudflare Durable Objects execute hourly checks and push top opportunities.",
        actionSteps: [
          "Navigate to ⏰ Schedulers sub-tab.",
          "Enable 'Autonomous Market Opportunity Scanner' across symbol baskets.",
          "When composite scores exceed threshold (e.g. Score ≥ 80), notification cards are dispatched to Slack or email.",
        ],
        samplePayloadOrCommand: "scheduleScreening({ symbols: ['NVDA', 'AAPL', 'TSLA'], minScore: 80, interval: '1h' })",
        targetTab: "trading",
      },
    ],
    primaryWorkflow: "Strategy Discovery & Payoff Analyzer",
    secondaryWorkflow: "Autonomous Schedulers",
    keyParameters: "compositeScore, Regime: Balanced, bias: 50",
    optimalOutputStructure: "Top-ranked 2D payoff card with Greeks, net debit/credit, and risk-reward ratio",
    targetTab: "trading",
    samplePrompt: "Recommend me the best options opportunities on NVDA",
  },
  {
    id: "maxprofit-maxloss-budget",
    number: 2,
    question: "Find me options that have maxprofit > 0 and maxloss <= 30",
    category: "budget-risk",
    categoryLabel: "Budget & Risk Caps",
    summary: "Filters for micro-debit vertical spreads, out-of-the-money long options, or narrow butterflies where total risk is capped at $30.",
    theoreticalContext: "A trade requiring MaxProfit > 0 and MaxLoss ≤ $30.00 requires either:\n1. A micro-debit vertical spread (e.g. 50¢-wide or $1.00-wide debit spread trading for ≤ $0.30 net debit = $30 total risk).\n2. A low-cost out-of-the-money single call/put on a lower-priced underlying trading at premium ≤ $0.30 ($30.00 total cost per 100-share contract).\n3. A narrow credit spread where strike width minus net credit received ≤ $0.30.",
    mathematicalBasis: "NetDebit <= $0.30  ==>  MaxLoss = NetDebit * 100 <= $30.00",
    methods: [
      {
        name: "Method A: Budget-Capped Strategy Discovery",
        badge: "Budget Filter",
        badgeColor: "blue",
        description: "In Strategy Discovery, configure the Budget filter to $30 and set Min Reward/Risk to ≥ 1:1. The engine guarantees max loss strictly stays at or below $30.",
        actionSteps: [
          "Open Auto Options Research → 🎯 Strategy Discovery.",
          "In the 'Budget ($)' input field, enter 30.",
          "In 'Min R:R' dropdown, select '≥ 1:1' (ensures MaxProfit > MaxLoss).",
          "Surfaces qualifying spreads (e.g., $1-wide call spread for $0.25 debit = $25 max loss, $75 max profit).",
        ],
        samplePayloadOrCommand: "filter: { budget: 30, minRewardRisk: 1.0, maxLoss: 30 }",
        targetTab: "trading",
      },
      {
        name: "Method B: Raw Contracts Screener (Single Leg Ask Cap)",
        badge: "Raw Screener",
        badgeColor: "green",
        description: "In Raw Contracts Screener, filter contracts with Ask price ≤ $0.30 across liquid monthly or weekly expirations.",
        actionSteps: [
          "Open Auto Options Research → 📋 Raw Contracts Screener.",
          "Select Underlying: NVDA (or AMD, TSLA) | Contract Type: Calls & puts.",
          "Filter by Max Ask: $0.30 ($30 per contract).",
          "Returns all liquid single-leg options whose maximum loss is strictly limited to premium paid ($30).",
        ],
        samplePayloadOrCommand: "screenOptions({ underlyingSymbols: ['NVDA'], maxAsk: 0.30, contractType: 'BOTH' })",
        targetTab: "trading",
      },
      {
        name: "Method C: Conversational Query via NLQ",
        badge: "NLQ Agent",
        badgeColor: "purple",
        description: "Type or speak: 'Find me options on AMD with maxprofit > 0 and maxloss <= 30'. The parser maps constraints directly into strategy discovery.",
        actionSteps: [
          "Type command in the platform command bar.",
          "The NLQ engine parses maxLoss: 30, minProfit: 0.01, applies client-side filtering over generated spreads.",
          "Displays clickable payoff cards with exact breakevens.",
        ],
        samplePayloadOrCommand: "Find me options on AMD with maxprofit > 0 and maxloss <= 30",
        targetTab: "chat",
      },
    ],
    primaryWorkflow: "Strategy Discovery & Payoff Analyzer",
    secondaryWorkflow: "Raw Contracts Screener",
    keyParameters: "budget: 30, minRewardRisk: 1.0, maxLoss: 30",
    optimalOutputStructure: "Capped debit spreads or low-cost verticals with net debit ≤ $0.30 and positive upside",
    targetTab: "trading",
    samplePrompt: "Find me options on AMD with maxprofit > 0 and maxloss <= 30",
  },
  {
    id: "maxchance-maxreturn",
    number: 3,
    question: "Find me options that have maxchance and maxreturn",
    category: "chance-return",
    categoryLabel: "Pareto Optimization",
    summary: "Balances Probability of Profit (POP) against Return-on-Risk (RoR%) to find Pareto-optimal setups along the efficiency frontier.",
    theoreticalContext: "In options pricing, Probability of Profit (Chance) and Return-on-Risk (Return) are naturally inversely correlated:\n• Out-of-the-Money options have high maximum return (low cost, high leverage) but low POP.\n• Deep In-the-Money or credit spreads have high POP (75–90%) but lower percentage returns.\nFinding structures that maximize both means finding the Pareto-Optimal Frontier—maximizing Expected Value: EV = (POP * Profit) - ((1 - POP) * Loss).",
    mathematicalBasis: "Pareto Frontier: argmax_{legs} [ POP(legs), RoR%(legs) ]",
    methods: [
      {
        name: "Method A: Optimization Bias Slider (Strategy Discovery)",
        badge: "Bias Slider",
        badgeColor: "blue",
        description: "In Strategy Discovery, use the Optimization Bias Slider:\n• 0% (Max Return): Ranks candidates purely by return multiplier (300%+ RoR%).\n• 100% (Max Chance): Ranks candidates purely by Probability of Profit (POP > 75%).\n• 50% (Balanced EV): Optimizes geometric balance between win rate and payoff multiple.",
        actionSteps: [
          "Open Strategy Discovery & Payoff Analyzer.",
          "Set Optimization Bias Slider to 50% for balanced Expected Value.",
          "Review top candidates for optimal balance between high win-rate and high percentage return.",
        ],
        samplePayloadOrCommand: "discoverStrategies({ symbol: 'NVDA', optimizationBias: 50 })",
        targetTab: "trading",
      },
      {
        name: "Method B: Broken Wing Butterflies & Ratio Spreads",
        badge: "Asymmetric Spreads",
        badgeColor: "purple",
        description: "Select Broken Wing Butterfly or Jade Lizard from the 72-strategy library. These asymmetric structures eliminate risk on one side (70%+ POP) while retaining substantial profit at center strike.",
        actionSteps: [
          "In Strategy Discovery, click 'Choose Strategy' → select 'Broken Wing Butterfly'.",
          "Adjust center strike near expected pin target.",
          "Payoff chart shows zero risk on one side with high payoff peak in center.",
        ],
        samplePayloadOrCommand: "strategy: 'broken_wing_butterfly', targetPrice: 130",
        targetTab: "trading",
      },
      {
        name: "Method C: Conversational Query via NLQ",
        badge: "NLQ Agent",
        badgeColor: "green",
        description: "Prompt: 'Find me TSLA options with maximum chance and return balance'. Sets optimizationBias = 50 and queries OptionStrat catalog.",
        actionSteps: [
          "Ask AI Agent: 'Find me TSLA options with maximum chance and return balance'.",
          "Agent computes expected values and returns top 3 frontier setups.",
        ],
        samplePayloadOrCommand: "Find me TSLA options with maximum chance and return balance",
        targetTab: "chat",
      },
    ],
    primaryWorkflow: "Strategy Discovery & Payoff Analyzer",
    secondaryWorkflow: "NLQ & Voice Trading",
    keyParameters: "optimizationBias: 50, Pareto Frontier",
    optimalOutputStructure: "Balanced POP vs RoR% Pareto candidates with expected value breakdown",
    targetTab: "trading",
    samplePrompt: "Find me TSLA options with maximum chance and return balance",
  },
  {
    id: "combinations-butterflies-diagonals",
    number: 4,
    question: "Find me combinations of options (e.g. butterflies and diagonals)",
    category: "combinations",
    categoryLabel: "Multi-Leg Structures",
    summary: "Builds and evaluates complex combinations across multiple strikes (Butterflies/Condors) and different expiration cycles (Diagonals/Calendars).",
    theoreticalContext: "Combinations involve multi-leg structures with different strikes (Butterflies, Iron Condors) or different expiration cycles (Diagonals, Calendars, Double Diagonals).\n• Long Butterfly: 3 strikes (Buy 1 Lower, Sell 2 Middle, Buy 1 Upper) designed for range-bound pinning.\n• Diagonal Spread: Buy longer DTE option, sell shorter DTE option at different strike (e.g. Poor Man's Covered Call).",
    mathematicalBasis: "Butterfly: +1 C(K1, T) - 2 C(K2, T) + 1 C(K3, T) where K2 - K1 = K3 - K2",
    methods: [
      {
        name: "Method A: 72-Strategy Library Modal",
        badge: "Strategy Catalog",
        badgeColor: "blue",
        description: "In Strategy Discovery, click 'Choose Strategy (50+)' to view curated categories: Butterflies, Diagonals & Calendars, Multi-Leg Hybrids, and Straddles/Strangles.",
        actionSteps: [
          "Open Strategy Discovery & Payoff Analyzer.",
          "Click 'Choose Strategy (50+)' button.",
          "Select 'Long Call Butterfly', 'Diagonal Call Spread', or 'Double Diagonal'.",
          "The interactive 2D payoff curve loads instantly with automatic strike selection.",
        ],
        samplePayloadOrCommand: "strategyType: 'long_call_butterfly' | 'diagonal_call_spread'",
        targetTab: "trading",
      },
      {
        name: "Method B: Payoff Builder Custom Leg Builder",
        badge: "Custom Builder",
        badgeColor: "orange",
        description: "Manually build combinations in Payoff Analyzer: click '+ Add Option Leg', select near-term expiry for short leg and far-term expiry for long leg to assemble custom diagonals.",
        actionSteps: [
          "In Payoff Analyzer, click '+ Add Option Leg'.",
          "Leg 1: Expiry 14 DTE, Strike $130, Action SELL.",
          "Leg 2: Expiry 60 DTE, Strike $120, Action BUY.",
          "Renders 2D date matrix simulating theta decay across different expiration cycles.",
        ],
        samplePayloadOrCommand: "legs: [{ strike: 130, dte: 14, action: 'SELL' }, { strike: 120, dte: 60, action: 'BUY' }]",
        targetTab: "trading",
      },
      {
        name: "Method C: Conversational Chat Prompt",
        badge: "NLQ Chat",
        badgeColor: "green",
        description: "Prompt: 'Build me a diagonal spread on NVDA' or 'Show me butterfly combinations on TSLA'. The agent parses the multi-leg intent and renders the payoff curve.",
        actionSteps: [
          "Type in chat: 'Build me a diagonal spread on NVDA'.",
          "Agent extracts multi-expiration intent, generates candidate legs via strategyLibrary.ts, and loads the interactive graph.",
        ],
        samplePayloadOrCommand: "Build me a diagonal spread on NVDA",
        targetTab: "chat",
      },
    ],
    primaryWorkflow: "Strategy Discovery & Payoff Analyzer",
    secondaryWorkflow: "72-Strategy Catalog Modal",
    keyParameters: "Strategy Group: Butterfly / Diagonal, multi-expiry",
    optimalOutputStructure: "Multi-expiry or multi-wing payoff matrix with 2D calendar date progression",
    targetTab: "trading",
    samplePrompt: "Build me a diagonal spread on NVDA",
  },
  {
    id: "volatility-volume-liquidity",
    number: 5,
    question: "Find me options with volatility, volume, liquidity",
    category: "liquidity",
    categoryLabel: "Liquidity & Greeks",
    summary: "Filters contract chains by institutional liquidity thresholds (Volume ≥ 500, OI ≥ 1,000, Spread ≤ 5%) while sorting by Implied Volatility.",
    theoreticalContext: "• High Implied Volatility (IV): Provides elevated premium yields for sellers and massive explosive potential for long gamma buyers.\n• High Volume & Liquidity: Essential for trade execution quality (tight bid-ask spread ≤ 5%, high open interest preventing slippage).\n• Volume-to-Open-Interest (Vol/OI): Anomaly metric where Vol/OI > 1.5 flags institutional positioning.",
    mathematicalBasis: "Spread% = (Ask - Bid) / Mid <= 0.05  AND  Volume >= 500  AND  OI >= 1000",
    methods: [
      {
        name: "Method A: Raw Contracts Screener Liquidity Multi-Filter",
        badge: "Raw Screener",
        badgeColor: "blue",
        description: "In Raw Contracts Screener, set Min Volume: 500, Min OI: 1,000, Max Spread %: 5.0%, and Sort By: Implied Volatility.",
        actionSteps: [
          "Open Auto Options Research → 📋 Raw Contracts Screener.",
          "Underlying: NVDA (or SPY, TSLA) | Contract Type: Calls & puts.",
          "Min Volume: 500 | Min OI: 1000 | Max Spread %: 5.0%.",
          "Surfaces contracts meeting institutional liquidity with full Greeks (Delta, Gamma, Theta, Vega, IV).",
        ],
        samplePayloadOrCommand: "screenOptions({ underlyingSymbols: ['NVDA'], minVolume: 500, minOpenInterest: 1000, maxSpreadPercent: 5.0 })",
        targetTab: "trading",
      },
      {
        name: "Method B: Institutional Options Flows & Vol/OI Spikes",
        badge: "Flows Tape",
        badgeColor: "purple",
        description: "Navigate to Options Flows tab. Filter by Vol/OI > 2.0x and Premium > $250,000 to identify institutional sweep activity in high-IV names.",
        actionSteps: [
          "Open Options Flows tab.",
          "Filter by Premium: > $250k and Vol/OI > 1.5x.",
          "Returns real-time sweeps and blocks with aggressive positioning.",
        ],
        samplePayloadOrCommand: "getOptionsFlows({ minPremium: 250000, minVolOiRatio: 1.5 })",
        targetTab: "options-flows",
      },
      {
        name: "Method C: NLQ Command",
        badge: "NLQ Agent",
        badgeColor: "green",
        description: "Prompt: 'Screen options on NVDA with volume > 500, tight spreads, and IV > 50%'. Maps parameters directly to options screening engine.",
        actionSteps: [
          "Type prompt in chat or command bar.",
          "Agent executes screening call and returns tabular chain preview.",
        ],
        samplePayloadOrCommand: "Screen options on NVDA with volume > 500, tight spreads, and IV > 50%",
        targetTab: "chat",
      },
    ],
    primaryWorkflow: "Raw Contracts Screener",
    secondaryWorkflow: "Options Flows & Institutional Activity",
    keyParameters: "minVol: 500, maxSpread: 5%, minOI: 1000, sort: iv",
    optimalOutputStructure: "Filtered contract chain table with Greeks, bid-ask spread %, volume, and IV metrics",
    targetTab: "trading",
    samplePrompt: "Screen options on NVDA with volume > 500, tight spreads, and IV > 50%",
  },
  {
    id: "bullish-bearish-combos",
    number: 6,
    question: "Find me the most bullish and most bearish combos",
    category: "directional",
    categoryLabel: "Directional Bias",
    summary: "Filters strategy catalog by extreme positive Delta (Δ ≥ +0.60) for bullish leverage or extreme negative Delta (Δ ≤ -0.60) for bearish breakdown protection.",
    theoreticalContext: "• Most Bullish Combos: Offer maximum positive Delta (Δ ≥ +0.60 to +1.0) with uncapped or high multiple upside (e.g. Long Synthetic Future, Bull Call Debit Spread, Long Call, Super Bullish Risk Reversal).\n• Most Bearish Combos: Offer maximum negative Delta (Δ ≤ -0.60 to -1.0) with strong downside leverage (e.g. Short Synthetic Future, Bear Put Debit Spread, Long Put, Bear Put Ratio Spread).",
    mathematicalBasis: "Net Delta = sum( leg_quantity_i * delta_i ). Bullish: Delta > 0.60, Bearish: Delta < -0.60",
    methods: [
      {
        name: "Method A: Sentiment Filter Buttons in Strategy Discovery",
        badge: "Sentiment Filter",
        badgeColor: "blue",
        description: "In Strategy Discovery:\n• Click '🚀 Very Bullish' or '🐂 Bullish': Filters strictly to strategies with Delta > 0.60 (Synthetic Long Stock, Bull Call Spreads, Call Backspreads).\n• Click '🩸 Very Bearish' or '🐻 Bearish': Filters strictly to strategies with Delta < -0.60 (Synthetic Short Stock, Bear Put Spreads, Put Backspreads).",
        actionSteps: [
          "Open Strategy Discovery & Payoff Analyzer.",
          "Click 'Very Bullish' or 'Very Bearish' sentiment buttons.",
          "Discovery engine filters catalog and ranks by net directional leverage.",
        ],
        samplePayloadOrCommand: "sentiment: 'very_bullish' | 'very_bearish'",
        targetTab: "trading",
      },
      {
        name: "Method B: Net Sentiment Flow Leaderboards",
        badge: "Flows Leaderboard",
        badgeColor: "purple",
        description: "In Options Flows, inspect the dual sentiment leaderboards:\n• Top Net Bullish: Ranks tickers with greatest institutional dollar flow in ask-side call buys / bid-side put sales.\n• Top Net Bearish: Ranks tickers with greatest flow in ask-side put buys / bid-side call sales.",
        actionSteps: [
          "Navigate to Options Flows tab.",
          "Inspect Top 10 Bullish and Top 10 Bearish ticker leaderboards.",
          "Click any ticker to pivot directly into options strategy discovery.",
        ],
        samplePayloadOrCommand: "getFlowSummary() → netBullishLeaderboard, netBearishLeaderboard",
        targetTab: "options-flows",
      },
      {
        name: "Method C: Conversational Query",
        badge: "NLQ Agent",
        badgeColor: "green",
        description: "Prompt: 'Show me the most aggressive bullish combo on TSLA'. Generates Synthetic Long Future (Buy ATM Call + Sell ATM Put) providing 1:1 stock delta replication at near-zero net debit.",
        actionSteps: [
          "Ask AI Agent: 'Show me the most aggressive bullish combo on TSLA'.",
          "Agent returns synthetic long future or ratio spread with payoff graph.",
        ],
        samplePayloadOrCommand: "Show me the most aggressive bullish combo on TSLA",
        targetTab: "chat",
      },
    ],
    primaryWorkflow: "Strategy Discovery & Payoff Analyzer",
    secondaryWorkflow: "Options Flows & Net Sentiment",
    keyParameters: "sentiment: Very Bullish / Very Bearish, Delta > 0.60 or < -0.60",
    optimalOutputStructure: "High-Delta directional spread or synthetic structure with max profit/loss profile",
    targetTab: "trading",
    samplePrompt: "Show me the most aggressive bullish combo on TSLA",
  },
  {
    id: "defined-undefined-risk",
    number: 7,
    question: "Find me options with defined risk / undefined risk",
    category: "defined-risk",
    categoryLabel: "Risk Categorization",
    summary: "Categorizes setups into strictly capped loss structures (Defined Risk: Spreads, Condors, Butterflies) versus unlimited margin loss structures (Undefined Risk: Naked Calls/Puts).",
    theoreticalContext: "• Defined Risk: Maximum dollar loss is strictly known and capped prior to trade entry (e.g. Long Calls, Long Puts, Vertical Spreads, Iron Condors, Butterflies). Unlimited catastrophic loss is mathematically impossible.\n• Undefined Risk: Maximum potential loss is unlimited or significantly exceeds initial collateral (e.g. Naked Short Calls, Naked Short Puts, Short Straddles, Short Strangles). Requires highest broker margin approval.",
    mathematicalBasis: "Defined Risk: MaxLoss < infinity (explicit dollar cap). Undefined Risk: MaxLoss = infinity",
    methods: [
      {
        name: "Method A: Visual Risk Badging in Strategy Discovery",
        badge: "Visual Badging",
        badgeColor: "blue",
        description: "Every strategy card in the catalog displays an explicit color-coded risk badge:\n• 🛡️ Defined Risk (Green): Explicit dollar loss ceiling (e.g. Max Loss: $150.00).\n• ⚠️ Undefined Risk (Red): Highlights unlimited loss potential (e.g. Max Loss: Unlimited).\n• 📦 Covered Risk (Amber): Collateralized by underlying stock shares.",
        actionSteps: [
          "Open Strategy Discovery & Payoff Analyzer.",
          "Review strategy cards; inspect the green '🛡️ Defined Risk' or red '⚠️ Undefined Risk' tag.",
          "Defined risk cards display exact dollar collateral required at trade entry.",
        ],
        samplePayloadOrCommand: "strategy.riskType === 'defined' | 'undefined' | 'covered'",
        targetTab: "trading",
      },
      {
        name: "Method B: Pluggable Strategy Registry Guards",
        badge: "Backend Policy",
        badgeColor: "orange",
        description: "In the strategy engine registry, users or automated schedulers can enforce risk policy. If riskPolicy === 'defined_only', all unlimited loss candidates are rejected with reason 'UNDEFINED_RISK_PROHIBITED'.",
        actionSteps: [
          "API / Schedulers pass riskPolicy: 'defined_only'.",
          "Engine automatically prunes naked short straddles and strangles.",
          "Ensures only capped multi-leg verticals, condors, and butterflies are returned.",
        ],
        samplePayloadOrCommand: "evaluateStrategies({ riskPolicy: 'defined_only' })",
        targetTab: "trading",
      },
      {
        name: "Method C: NLQ Prompting",
        badge: "NLQ Agent",
        badgeColor: "green",
        description: "Prompt: 'Find me neutral options with defined risk on SPY'. Recommends an Iron Condor or Iron Butterfly, explicitly omitting naked Short Straddles.",
        actionSteps: [
          "Ask AI Agent: 'Find me neutral options with defined risk on SPY'.",
          "Agent presents an Iron Condor with defined risk wings.",
        ],
        samplePayloadOrCommand: "Find me neutral options with defined risk on SPY",
        targetTab: "chat",
      },
    ],
    primaryWorkflow: "Strategy Discovery & Payoff Analyzer",
    secondaryWorkflow: "Brokerage HITL Guard",
    keyParameters: "riskPolicy: defined_only, riskType: defined | undefined",
    optimalOutputStructure: "Verified capped-loss structures with explicit collateral requirement and safety badge",
    targetTab: "trading",
    samplePrompt: "Find me neutral options with defined risk on SPY",
  },
  {
    id: "least-risk",
    number: 8,
    question: "Find me options with least risk",
    category: "least-risk",
    categoryLabel: "Capital Preservation",
    summary: "Targets trades with either minimum dollar capital at risk (Max Loss ≤ $25) or maximum statistical probability of profit (POP ≥ 85-92% with deep safety cushion).",
    theoreticalContext: "'Least Risk' represents two distinct objectives in quantitative trading:\n1. Minimum Capital at Risk (Absolute Lowest Dollar Risk): Tiny net debit outlay (≤ $20) so maximum possible loss is negligible.\n2. Highest Statistical Safety (Lowest Probability of Loss): Wide credit spreads or collars with deep safety cushion (≥ 10–15% drop before losing money) and POP ≥ 85–90%.",
    mathematicalBasis: "Safety Cushion = (Spot - Breakeven) / Spot >= 0.10  AND  POP >= 0.85",
    methods: [
      {
        name: "Method A: Max Chance Optimizer (Highest Statistical Safety)",
        badge: "Statistical Safety",
        badgeColor: "blue",
        description: "In Strategy Discovery, set the Optimization Slider to 100% (Max Chance). Recommends wide out-of-the-money Bull Put Spreads or Cash-Secured Puts with strikes set 2 standard deviations OTM (Delta ≤ 0.10, POP 88–92%).",
        actionSteps: [
          "Open Strategy Discovery & Payoff Analyzer.",
          "Move Optimization Bias slider all the way to 100% (Max Chance).",
          "Engine selects wide credit spreads where underlying can drop 10-15% before loss begins.",
        ],
        samplePayloadOrCommand: "discoverStrategies({ symbol: 'NVDA', optimizationBias: 100 })",
        targetTab: "trading",
      },
      {
        name: "Method B: Budget Cap (Absolute Lowest Dollar Risk)",
        badge: "Budget Cap",
        badgeColor: "green",
        description: "In Strategy Discovery, enter Budget: 25. Surfaces narrow debit spreads or broken wing structures with maximum dollar loss strictly capped at $25.00.",
        actionSteps: [
          "Enter Budget: 25 in the Discovery filter box.",
          "Discovery engine limits candidates to structures requiring ≤ $25 collateral.",
        ],
        samplePayloadOrCommand: "filter: { budget: 25 }",
        targetTab: "trading",
      },
      {
        name: "Method C: Collars & Protective Puts",
        badge: "Hedging Structure",
        badgeColor: "purple",
        description: "In the 50+ Strategy Library, select Collar (Long 100 Shares + Sell OTM Call to finance Buy of OTM Put). Downside is fully hedged by the protective put at near-zero net cost.",
        actionSteps: [
          "Choose Strategy → select 'Collar'.",
          "Payoff graph demonstrates zero downside catastrophe risk below put strike.",
        ],
        samplePayloadOrCommand: "strategy: 'collar', shares: 100",
        targetTab: "trading",
      },
    ],
    primaryWorkflow: "Strategy Discovery & Payoff Analyzer",
    secondaryWorkflow: "72-Strategy Catalog Modal",
    keyParameters: "optimizationBias: 100 (Max Chance), budget: 25, POP ≥ 90%",
    optimalOutputStructure: "Deep OTM credit spreads (POP ≥ 90%) or Collars with explicit downside floor",
    targetTab: "trading",
    samplePrompt: "Find me options with least risk on NVDA",
  },
];

export const WORKFLOW_IMPROVEMENTS: WorkflowImprovementItem[] = [
  {
    id: "imp-cross-sectional-scan",
    number: 1,
    title: "Multi-Underlying Cross-Sectional Constraint Scanning",
    currentLimitation: "The Strategy Discovery engine currently evaluates strategies on one symbol at a time (e.g. only NVDA or TSLA). When a user asks: 'Find me options with maxprofit > 0 and maxloss <= 30', the system cannot scan across the S&P 500 or Nasdaq 100 to return the best setup across the market.",
    proposedEnhancement: "Implement an asynchronous batch scanning service in optionsScreener.ts that accepts a basket of underlyings (top 50 liquid optionable tickers). Worker threads or edge isolates evaluate candidate spreads concurrently and aggregate top candidates across the equity universe into a unified cross-asset leaderboard.",
    impact: "Unlocks market-wide discovery for budget and risk queries without requiring users to guess which symbol has valid setups.",
    targetComponents: ["src/trading/optionsScreener.ts", "src/client/options/strategyDiscoveryEngine.ts"],
  },
  {
    id: "imp-pareto-optimizer",
    number: 2,
    title: "Multi-Objective Pareto Optimization Engine",
    currentLimitation: "The Optimization Bias slider currently uses a linear scalarization between Return and Chance (0...100). It does not calculate the true Pareto Efficient Frontier for trades that simultaneously optimize for both dimensions.",
    proposedEnhancement: "Integrate an NSGA-II or Pareto-rank sorting algorithm into strategyDiscoveryEngine.ts. Identify trades on the frontier where no other trade provides higher POP without lowering return, or higher return without lowering POP. Allow users to filter by 'Pareto Tier 1' setups.",
    impact: "Mathematically guarantees optimal trade recommendations without arbitrary slider weighting.",
    targetComponents: ["src/client/options/strategyDiscoveryEngine.ts"],
  },
  {
    id: "imp-constraint-solver",
    number: 3,
    title: "Declarative Multi-Leg Constraint Solver",
    currentLimitation: "Spreads and multi-leg combinations are currently constructed using fixed rules (e.g. wing width = 5 points, offset = 2 strikes). When a user asks for 'maxloss <= 30', the engine tries pre-set widths and filters out those that exceed $30. If standard strikes don't match, it returns empty results.",
    proposedEnhancement: "Implement an inverse constraint solver: Width - Credit <= 0.30 ==> Credit >= Width - 0.30. The engine calculates the required strike differentials directly from live bid/ask chains to dynamically discover valid combinations instead of trial-and-error filtering.",
    impact: "Eliminates empty discovery results for strict budget and risk cap requests.",
    targetComponents: ["src/trading/options/strategyEngine.ts", "src/client/options/strategyLibrary.ts"],
  },
  {
    id: "imp-vol-surface-model",
    number: 4,
    title: "Unified Cross-Asset Liquidity & Volatility Surface Model",
    currentLimitation: "Implied Volatility (IV) is treated as a flat constant across strikes and expirations in the local Black-Scholes module. Real options markets exhibit volatility skew (puts trade at higher IV than calls) and term structure (near-term IV differs from far-term IV).",
    proposedEnhancement: "Model the full IV smile/skew across delta buckets (10, 25, 50, 75, 90) using SVI (Stochastic Volatility Inspired) parametrization or Cubic Spline interpolation. Ensures multi-leg credit and debit pricing, breakevens, and probability densities accurately reflect market skew.",
    impact: "Prevents mispricing on OTM wing options and delivers institutional-grade Probability of Profit accuracy.",
    targetComponents: ["src/trading/options/calibratedOptionChains.ts", "src/client/options/blackScholes.ts"],
  },
  {
    id: "imp-nlq-deep-linking",
    number: 5,
    title: "Direct NLQ-to-Payoff Builder Deep Linking",
    currentLimitation: "When a user queries via NLQ or Chat, the agent returns text summaries and markdown tables. The user must manually navigate to the Auto Options Research tab and reconstruct the trade to view payoff charts.",
    proposedEnhancement: "Every NLQ response should generate a clickable deep link containing encoded trade state: #trade=NVDA:BULL_PUT_SPREAD:120P_115P:2025-02-21. Clicking the link transitions the user directly to the Auto Options Research 2D Payoff Analyzer with legs, strikes, and date matrix pre-loaded for instant interactive exploration.",
    impact: "Creates seamless zero-friction handoff between conversational AI and interactive quantitative visualizers.",
    targetComponents: ["src/agents/optionsNlqAgent.ts", "src/client/options/PayoffChart.tsx"],
  },
  {
    id: "imp-flow-informed-discovery",
    number: 6,
    title: "Real-Time Flow-Informed Strategy Discovery",
    currentLimitation: "Workflow 2 (Strategy Discovery) and Workflow 4 (Options Flows) operate independently. Discovery does not know whether institutions are aggressively buying or selling the contracts it recommends.",
    proposedEnhancement: "Inject institutional flow signals into the Opportunity Scoring algorithm: S_flow = (NetCallPremium - NetPutPremium) / TotalPremium. When recommending bullish spreads, boost the score of strikes that align with active institutional sweep prints from Workflow 4.",
    impact: "Bridges quantitative strategy modeling with real-time institutional smart-money confirmation.",
    targetComponents: ["src/trading/options/flows/flowService.ts", "src/client/options/strategyDiscoveryEngine.ts"],
  },
];

export const CAPABILITY_MATRIX: CapabilityMatrixRow[] = [
  {
    question: "Best Opportunities",
    primaryWorkflow: "Strategy Discovery & Payoff Analyzer",
    secondaryWorkflow: "Autonomous Schedulers",
    keyInputParameter: "compositeScore / Regime: Balanced",
    optimalOutputStructure: "Top-ranked 2D payoff card with Greeks",
    targetTab: "trading",
  },
  {
    question: "Max Profit > 0 & Max Loss <= 30",
    primaryWorkflow: "Strategy Discovery & Payoff Analyzer",
    secondaryWorkflow: "Raw Contracts Screener",
    keyInputParameter: "budget: 30, minRewardRisk: 1.0",
    optimalOutputStructure: "Capped debit spreads / low-cost verticals",
    targetTab: "trading",
  },
  {
    question: "Max Chance & Max Return",
    primaryWorkflow: "Strategy Discovery & Payoff Analyzer",
    secondaryWorkflow: "NLQ Engine",
    keyInputParameter: "optimizationBias: 50",
    optimalOutputStructure: "Balanced POP vs RoR% Pareto candidates",
    targetTab: "trading",
  },
  {
    question: "Combinations (Butterflies / Diagonals)",
    primaryWorkflow: "Strategy Discovery & Payoff Analyzer",
    secondaryWorkflow: "72-Strategy Catalog Modal",
    keyInputParameter: "Strategy Group: Butterfly / Diagonal",
    optimalOutputStructure: "Multi-expiry / multi-wing payoff matrix",
    targetTab: "trading",
  },
  {
    question: "Volatility, Volume, Liquidity",
    primaryWorkflow: "Raw Contracts Screener",
    secondaryWorkflow: "Options Flows & Institutional Activity",
    keyInputParameter: "minVol: 500, maxSpread: 5%, sort: iv",
    optimalOutputStructure: "Filtered contract chain table with Greeks",
    targetTab: "trading",
  },
  {
    question: "Most Bullish / Bearish Combos",
    primaryWorkflow: "Strategy Discovery & Payoff Analyzer",
    secondaryWorkflow: "Options Flows",
    keyInputParameter: "Sentiment: Very Bullish / Very Bearish",
    optimalOutputStructure: "High-Delta synthetic or ratio spreads",
    targetTab: "trading",
  },
  {
    question: "Defined vs Undefined Risk",
    primaryWorkflow: "Strategy Discovery & Payoff Analyzer",
    secondaryWorkflow: "Brokerage HITL Guard",
    keyInputParameter: "riskPolicy: defined_only",
    optimalOutputStructure: "Verified capped-loss structures",
    targetTab: "trading",
  },
  {
    question: "Least Risk",
    primaryWorkflow: "Strategy Discovery & Payoff Analyzer",
    secondaryWorkflow: "72-Strategy Catalog Modal",
    keyInputParameter: "optimizationBias: 100 (Max Chance)",
    optimalOutputStructure: "Deep OTM credit spreads (POP >= 90%) or Collars",
    targetTab: "trading",
  },
];
