export interface FaqExecutionMethod {
  name: string;
  badge: string;
  badgeColor: "blue" | "green" | "purple" | "orange";
  description: string;
  actionSteps: string[];
  samplePayloadOrCommand?: string;
  targetTab?: string;
}

export interface ParameterBadge {
  label: string;
  value: string;
  hint?: string;
}

export interface FaqQuestionItem {
  id: string;
  number: number;
  question: string;
  category: "opportunities" | "budget-risk" | "chance-return" | "combinations" | "liquidity" | "directional" | "defined-risk" | "least-risk";
  categoryLabel: string;
  summary: string;
  quickTakeaway?: string;
  parameterBadges?: ParameterBadge[];
  relatedDecisionRuleId?: string;
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

export interface DecisioningRule {
  name: string;
  description: string;
  formulaOrCode?: string;
  parametersOrGates?: string[];
}

export interface DecisioningMatrixRow {
  dimension: string;
  weightOrValue: string;
  details: string;
}

export interface DecisioningSection {
  id: string;
  number: number;
  title: string;
  subtitle: string;
  badge: string;
  badgeColor: "green" | "blue" | "purple" | "orange" | "cyan";
  governedWorkflows?: string[];
  overview: string;
  rules: DecisioningRule[];
  matrixOrWeights?: DecisioningMatrixRow[];
  concreteExample: {
    title: string;
    input: string;
    evaluation: string;
    verdict: string;
  };
}

export const FAQ_QUESTIONS: FaqQuestionItem[] = [
  {
    id: "best-opportunities",
    number: 1,
    question: "Find me the best opportunities / recommend me the best opportunities",
    category: "opportunities",
    categoryLabel: "Opportunity Ranking",
    summary: "Ranks multi-leg strategies by a multivariate composite score balancing Expected Value (EV), win rate (POP), bid-ask liquidity, and net theta yield.",
    quickTakeaway: "Open Strategy Discovery with 50% Balanced EV bias, or prompt the AI agent. The engine scans 72 strategies and scores them across EV, win rate (POP), liquidity, and theta yield.",
    parameterBadges: [
      { label: "Optimization Bias", value: "50% (Balanced EV)", hint: "Balances POP vs return" },
      { label: "Sentiment", value: "Bullish / Neutral / Bearish", hint: "Directional posture" },
      { label: "Liquidity Floor", value: "Vol ≥ 500, OI ≥ 1,000", hint: "Prevents execution slippage" },
      { label: "Scoring Model", value: "6-Factor Dot Product", hint: "Dot product of normalized vectors" },
    ],
    relatedDecisionRuleId: "multivariate-scoring-criteria",
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
    quickTakeaway: "Set Budget filter to $30 and Min R:R to ≥ 1:1 in Strategy Discovery, or filter Raw Contracts Screener with Max Ask ≤ $0.30. Guarantees maximum dollar loss never exceeds $30.",
    parameterBadges: [
      { label: "Budget Cap", value: "≤ $30.00", hint: "Strict maximum risk ceiling" },
      { label: "Min R:R", value: "≥ 1.0 (1:1)", hint: "Ensures Max Profit > Max Loss" },
      { label: "Max Debit", value: "≤ $0.30 / share", hint: "$30 per 100-share contract" },
      { label: "Structures", value: "Verticals / Micro-Debits", hint: "Defined-risk spreads" },
    ],
    relatedDecisionRuleId: "strategy-selection-rules",
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
    quickTakeaway: "Set Optimization Bias Slider to 50% (Balanced EV) or select asymmetric Broken Wing Butterflies / Jade Lizards. Finds the Pareto Efficient Frontier balancing win probability with percentage return.",
    parameterBadges: [
      { label: "Optimization Bias", value: "50% (Balanced EV)", hint: "Geometric mean of POP and return" },
      { label: "Efficiency Goal", value: "Pareto-Optimal Frontier", hint: "Non-dominated payoff profiles" },
      { label: "Asymmetric Setups", value: "Broken Wing Butterfly / Jade Lizard", hint: "Zero risk on one side" },
      { label: "Target Metric", value: "Max Expected Value (EV)", hint: "EV = POP*Profit - (1-POP)*Loss" },
    ],
    relatedDecisionRuleId: "multivariate-scoring-criteria",
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
    quickTakeaway: "Click 'Choose Strategy (72+)' in Strategy Discovery and select 'Butterflies' or 'Diagonals & Calendars', or assemble custom multi-expiry legs in the Visual Payoff Builder.",
    parameterBadges: [
      { label: "Strategy Groups", value: "Butterflies / Calendars / Diagonals", hint: "Multi-strike & multi-expiry" },
      { label: "Leg Multiplier", value: "3 to 4 Legs", hint: "Wing/center structure" },
      { label: "Visualizer", value: "2D Date Payoff Matrix", hint: "Simulates time decay across cycles" },
      { label: "Target Horizon", value: "Multi-DTE (14d short / 60d long)", hint: "Diagonal theta harvesting" },
    ],
    relatedDecisionRuleId: "strategy-selection-rules",
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
    quickTakeaway: "Open Raw Contracts Screener with Min Volume: 500, Min OI: 1,000, Max Spread: 5.0%, and Sort by: Implied Volatility; or check Options Flows for Sweeps with Vol/OI > 1.5x.",
    parameterBadges: [
      { label: "Volume Floor", value: "≥ 500 contracts", hint: "Active trading requirement" },
      { label: "Open Interest", value: "≥ 1,000 contracts", hint: "Market depth floor" },
      { label: "Spread Tightness", value: "≤ 5.0% of midpoint", hint: "Low slippage gate" },
      { label: "Vol/OI Anomaly", value: "> 1.5x Spike", hint: "Institutional accumulation flag" },
    ],
    relatedDecisionRuleId: "options-screener-logic",
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
    quickTakeaway: "Toggle '🚀 Very Bullish' (Delta ≥ +0.60, Bull Call/Synthetic Long) or '🩸 Very Bearish' (Delta ≤ -0.60, Bear Put/Synthetic Short) in Strategy Discovery, or check Net Sentiment Leaderboards in Options Flows.",
    parameterBadges: [
      { label: "Bullish Delta", value: "Δ ≥ +0.60 to +1.00", hint: "Aggressive upward replication" },
      { label: "Bearish Delta", value: "Δ ≤ -0.60 to -1.00", hint: "Downside crash leverage" },
      { label: "Top Setups", value: "Synthetic Futures / Ratio Spreads", hint: "Maximum directional sensitivity" },
      { label: "Flow Confirmation", value: "Net Bullish / Bearish Tape", hint: "Ask-side prints confirmation" },
    ],
    relatedDecisionRuleId: "strategy-selection-rules",
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
    quickTakeaway: "Inspect the visual '🛡️ Defined Risk' (green) or '⚠️ Undefined Risk' (red) tags on strategy cards, or enforce `riskPolicy: defined_only` in automated scans to eliminate naked options.",
    parameterBadges: [
      { label: "Defined Risk", value: "Max Loss < ∞ (Explicit Dollar Cap)", hint: "Spreads, condors, butterflies" },
      { label: "Undefined Risk", value: "Max Loss = ∞ (Uncapped)", hint: "Naked calls, naked puts, straddles" },
      { label: "Policy Filter", value: "riskPolicy: 'defined_only'", hint: "Prunes all unlimited loss setups" },
      { label: "Broker Tier", value: "Tier 2 vs Tier 4 Margin", hint: "Margin requirement clearance" },
    ],
    relatedDecisionRuleId: "additional-decisioning-gates",
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
    quickTakeaway: "Move Optimization Slider to 100% (Max Chance) for deep OTM credit spreads with POP ≥ 88-92% and 10-15% safety cushion, or set Budget: $25 for negligible absolute dollar risk.",
    parameterBadges: [
      { label: "Max Chance Bias", value: "100% Slider (Max POP)", hint: "2 standard deviations OTM" },
      { label: "Statistical Win Rate", value: "POP ≥ 88% – 92%", hint: "High-probability credit harvesting" },
      { label: "Safety Cushion", value: "≥ 10% – 15% drop allowed", hint: "Underlying can fall before loss" },
      { label: "Dollar Floor", value: "Collars / Protective Puts", hint: "Full downside hedge protection" },
    ],
    relatedDecisionRuleId: "pickbesttrades-engine",
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

export const DECISIONING_SECTIONS: DecisioningSection[] = [
  {
    id: "stock-screener-logic",
    number: 1,
    title: "Stock Screener Search, Ingestion & Fallback Decision Logic",
    subtitle: "Dynamic All-Exchange Discovery, Fallback Decision Tree, Indicators & Options Flow Integration",
    badge: "Equity Screener",
    badgeColor: "green",
    governedWorkflows: ["A1", "A4"],
    overview: "The Stock Screener (DynamicMarketScreener) discovers and evaluates equities across all US exchanges (NASDAQ, NYSE, AMEX). Options Flow and downstream modules do NOT default to a static list as their first option — they query DynamicMarketScreener first. The screener queries live all-exchange listings from api.nasdaq.com, and if that API is rate-limited, blocked, or unavailable, it decides whether to use a dynamic feed or fall back to the externalized curated universe (src/config/curatedStockUniverse.json).",
    rules: [
      {
        name: "Multi-Exchange Dynamic Listing Ingestion & Fallback Decision Tree",
        description: "Executes a multi-tiered ingestion hierarchy across NASDAQ, NYSE, and AMEX (~8,500 active securities), prioritizing authentic remote exchange feeds before falling back gracefully.",
        formulaOrCode: "Priority 1: fetchAllUsStockListings() via api.nasdaq.com/api/screener/stocks (~8,500 rows, paginated)\nPriority 2: If upstream is rate-limited, blocked, or returns empty -> DynamicMarketScreener autonomously activates fallback\nPriority 3: Ingests getCuratedStockListings() from src/config/curatedStockUniverse.json (with sector, market cap, and exchange metadata)\nAudit Stamp: discovery.mode = 'all_us_listings', tagged with source count audit statistics",
      },
      {
        name: "Options Flow Integration Rule: Screener-First Dynamic Resolution",
        description: "Guarantees that Options Flow never defaults to a static ticker list as its first option. Options Flow queries DynamicMarketScreener to obtain active market underlyings partitioned into market cap buckets.",
        formulaOrCode: "Options Flow invokes: DynamicMarketScreener.screenLive({ minPrice: 3.0 })\nScreener Decision: Attempts live multi-exchange scan -> falls back to curated universe only if offline\nPartitions results into:\n  - Large Cap: >= $10B (Mega/Large cap options volume leaders)\n  - Mid Cap: $2B - $10B (Russell midcap momentum movers)\n  - Small Cap: $250M - $2B (High-beta growth candidates)\n  - ETFs: SPY, QQQ, IWM, DIA, XLF, XLE, SMH, etc.\nSorts by absolute price change |changePercent| (top movers first)",
      },
      {
        name: "Equity Boundary Filtering & Penny Stock Exclusion",
        description: "Applies rigorous boundary gates across exchange, market cap, price, volume, and percentage change.",
        parametersOrGates: [
          "Exchange: NASDAQ, NYSE, AMEX, or ALL (Exchange filter ignores OTC/pink sheets)",
          "Price Gate: minPrice <= LastPrice <= maxPrice (Penny stock exclusions: Price >= $3.00 for optionable securities)",
          "Market Cap: Mega (>= $200B), Large (>= $10B), Mid ($2B-$10B), Small (< $2B)",
          "1D Price Change %: Absolute velocity filter (|changePercent|) highlighting breakout gainers/losers",
          "Volume Floor: minVolume >= threshold (Omits dormant or low-liquidity issues)",
        ],
      },
      {
        name: "Technical Momentum Indicators (RSI & MACD)",
        description: "Enriches candidates with 14-period daily RSI and MACD (12, 26, 9 EMA) using historical OHLCV chart bars.",
        formulaOrCode: "RSI > 70: Overbought (Potential mean-reversion or exhaustion)\nRSI < 30: Oversold Bounce (Fallen-angel pullback opportunity)\nMACD Line > Signal Line: Bullish Acceleration\nMACD Line < Signal Line: Bearish Contraction",
      },
      {
        name: "Auditable Stock Scan Ledger",
        description: "Maintains a verifiable ledger recording total scanned securities, passed candidates, and exact exclusion reasons.",
        parametersOrGates: [
          "EXCHANGE_MISMATCH: Ticker listing does not belong to selected exchange partition",
          "PRICE_OUT_OF_RANGE: Last sale price below minimum ($3.00 floor) or above ceiling",
          "MARKET_CAP_OUT_OF_RANGE: Market capitalization outside target tier",
          "NON_OPTIONABLE_SECURITY: Excluded warrants, rights, units, preferred shares, and debt notes",
          "CHANGE_PERCENT_OUT_OF_RANGE: Daily momentum change below requested threshold",
        ],
      },
    ],
    matrixOrWeights: [
      { dimension: "Priority 1 (Live Nasdaq)", weightOrValue: "api.nasdaq.com/api/screener/stocks", details: "All active US equities (~8,500 rows) with real-time 15m delayed exchange pricing" },
      { dimension: "Priority 2 (Yahoo FOSS)", weightOrValue: "query1.finance.yahoo.com/v8/finance/chart", details: "1-month daily historical OHLCV bars for 14-period RSI and MACD indicators" },
      { dimension: "Priority 3 (Curated Fallback)", weightOrValue: "src/config/curatedStockUniverse.json", details: "Resilient offline fallback with sector, market cap, and exchange metadata" },
      { dimension: "Downstream Client: Options Flow", weightOrValue: "DynamicMarketScreener.screenLive()", details: "Resolves dynamic market underlyings first before tape ingestion; never defaults to static list" },
    ],
    concreteExample: {
      title: "Screening All-Exchange Equities with Dynamic Options Flow Handoff",
      input: "Market: US Equities, Min Price: $3.00, Consumer: Options Flow resolveDynamicFlowSymbols()",
      evaluation: "DynamicMarketScreener queries Nasdaq API; receives 8,500 listings. Filters out warrants and penny stocks. Partitions top absolute movers: NVDA (+4.2%), TSLA (-3.1%), PLTR (+6.8%), AMD (+2.9%).",
      verdict: "Stock Screener returns 20 Large Cap, 20 Mid Cap, and 20 Small Cap symbols. Options Flow consumes these dynamic underlyings to query live options tape and synthesize flow leaderboards.",
    },
  },
  {
    id: "options-screener-logic",
    number: 2,
    title: "Raw Options Contracts Screener & Chain Filtering Engine",
    subtitle: "Multivariate Contract Filtering, Moneyness Bounds, Technical Signals & Rejection Ledgers",
    badge: "Options Screener",
    badgeColor: "blue",
    governedWorkflows: ["A3"],
    overview: "The Raw Contracts Screener evaluates individual call and put option contracts against strict institutional liquidity, risk, and pricing constraints. Sanitization normalizes user inputs, clamps negative bounds, and computes auditable rejection ledgers detailing exactly why each non-qualifying contract was omitted.",
    rules: [
      {
        name: "Boundary Filtering & Normalization",
        description: "Enforces multi-parameter thresholds across bid/ask spread, trading volume, open interest, expiration horizons, Greek risk dimensions, and quote freshness.",
        parametersOrGates: [
          "spreadPct <= maxSpreadPct (Bid-ask spread tightness relative to midpoint)",
          "volume >= minVolume & openInterest >= minOpenInterest (Liquidity floors)",
          "minDte <= DTE <= maxDte (Calendar horizon boundaries)",
          "minDelta <= |Delta| <= maxDelta (Absolute directional sensitivity)",
          "minGamma <= Gamma <= maxGamma & minTheta <= Theta <= maxTheta",
          "minVega <= Vega <= maxVega & minRho <= Rho <= maxRho",
          "minImpliedVolatility <= IV <= maxImpliedVolatility (Volatility bounds)",
          "quoteAgeSeconds <= maxQuoteAgeSeconds (Freshness boundary; defaults to 60s)",
        ],
      },
      {
        name: "Moneyness Classification",
        description: "Categorizes options into ITM, ATM, or OTM using a configurable At-The-Money percentage band (atmBandPct = 0.02, +/-2% of spot).",
        formulaOrCode: "Call ATM: spot * 0.98 <= strike <= spot * 1.02\nCall ITM: strike < spot * 0.98 | Call OTM: strike > spot * 1.02\nPut ATM: spot * 0.98 <= strike <= spot * 1.02\nPut ITM: strike > spot * 1.02 | Put OTM: strike < spot * 0.98",
      },
      {
        name: "Direction-Agnostic Technical Signals",
        description: "Enriches each passing contract with heuristic market condition tags based on volume surges and Greek momentum.",
        formulaOrCode: "volOiRatio >= 1.5x -> Unusual Volume Spike (Vol/OI: {ratio}x)\n|delta| >= 0.65 -> High Delta Momentum\nIV >= 70% -> High Implied Volatility Expansion\nIV <= 30% -> Low IV Value Opportunity\nOtherwise -> Liquid Standard Option",
      },
      {
        name: "Deterministic Sorting & Tie-Breaking",
        description: "Orders matching contracts according to user-selected sortBy key, with secondary tie-breakers on underlyingSymbol and strikePrice.",
        parametersOrGates: [
          "volume: Descending by contract trading volume",
          "spreadPct: Ascending by bid/ask spread % (tightest first)",
          "iv: Descending by implied volatility (highest volatility first)",
          "volumeOiRatio: Descending by volume-to-open-interest spike ratio",
          "dte: Ascending by days to expiration (nearest expiry first)",
          "strikeDistance: Ascending by absolute distance % from underlying spot",
        ],
      },
      {
        name: "Auditable Rejection Ledger (15 Codes)",
        description: "Maintains a machine-readable ledger capturing exact failure reasons for every contract evaluated.",
        parametersOrGates: [
          "ADJUSTED_CONTRACT: Excluded non-standard corporate action splits",
          "INVALID_QUOTE: Zero or inverted bid/ask quotes (bid <= 0 or ask < bid)",
          "SPREAD_TOO_WIDE: Spread % exceeds user or default threshold",
          "PREMIUM_OUT_OF_RANGE: Midpoint price outside min/max dollar bounds",
          "DTE_OUT_OF_RANGE: Expiration outside requested days-to-expiration window",
          "DELTA_OUT_OF_RANGE: Absolute Delta outside min/max bounds",
          "GAMMA_OUT_OF_RANGE / THETA_OUT_OF_RANGE / VEGA_OUT_OF_RANGE / RHO_OUT_OF_RANGE",
          "IV_OUT_OF_RANGE: Implied volatility outside min/max range",
          "VOLUME_TOO_LOW / OPEN_INTEREST_TOO_LOW: Failed minimum liquidity floor",
          "MONEYNESS_MISMATCH: Contract does not match requested ITM/ATM/OTM flag",
          "STRIKE_DISTANCE_TOO_WIDE: Strike distance % exceeds maximum boundary",
        ],
      },
    ],
    concreteExample: {
      title: "Screening NVDA ATM Call Contracts",
      input: "Symbol: NVDA (Spot: $125.00), Type: CALL, Min Volume: 500, Max Spread %: 4.0%, DTE: 14-45d, Moneyness: ATM",
      evaluation: "Contract NVDA250221C00125000: Strike: 125.00, DTE: 28d, Bid: $6.20, Ask: $6.40 (Spread: 3.17%), Vol: 14,200, OI: 8,400. Distance: 0.00% (ATM band <= 2%).",
      verdict: "PASSED -> Output as Row #1; tagged with 'Liquid Standard Option'. 1,142 other chain contracts rejected for DTE, volume, or spread.",
    },
  },
  {
    id: "strategy-selection-rules",
    number: 3,
    title: "Strategy Selection, Strike Placement & Expiration Horizon Rules",
    subtitle: "72-Strategy Catalog Resolution, Combinatorial Strike Generation & Horizon Pruning",
    badge: "Strategy Generation",
    badgeColor: "green",
    governedWorkflows: ["A2", "A5"],
    overview: "The Strategy Discovery and Recommendation engines generate viable multi-leg option strategies from a 72-strategy catalog (OptionStrat-grade). The engine matches market sentiment, generates strike ladders, applies user optimization bias, and prunes invalid or illiquid structures.",
    rules: [
      {
        name: "Sentiment & Thesis Mapping",
        description: "Filters candidate strategies based on market outlook, mapping 72 pre-built catalog structures to matching directional regimes.",
        parametersOrGates: [
          "Bullish / Very Bullish: Long Calls, Bull Call Spreads, Bull Put Spreads, Call Backspreads, Synthetic Longs, Covered Calls",
          "Bearish / Very Bearish: Long Puts, Bear Put Spreads, Bear Call Spreads, Put Backspreads, Synthetic Shorts",
          "Neutral / Range-Bound: Iron Condors, Iron Butterflies, Calendar Spreads, Long Butterflies, Jade Lizards, Double Diagonals",
          "Directional / High Volatility: Long Straddles, Long Strangles, Reverse Iron Condors, Reverse Iron Butterflies",
          "ALL: Evaluates complete 72-strategy library simultaneously",
        ],
      },
      {
        name: "Continuous Strike Ladder & Optimization Bias Shift",
        description: "Dynamically constructs candidate strikes around the underlying spot price and shifts strikes based on the Optimization Bias slider (0 = Max Return, 50 = Balanced EV, 100 = Max Chance).",
        formulaOrCode: "atmIndex = argmin(|strike - spot|)\nbiasShift = round(((50 - optimizationBias) / 50) * 3)\nTarget Strike Index = clamp(atmIndex + offset + biasShift, 0, strikes.length - 1)\n- Bias 0 (Max Return): Shifts +3 strikes OTM (higher leverage, lower POP)\n- Bias 50 (Balanced EV): Centers around ATM strikes\n- Bias 100 (Max Chance): Shifts -3 strikes ITM (higher win rate, lower multiple)",
      },
      {
        name: "Expiration Horizon Grouping",
        description: "Groups expiration cycles into three standardized trading horizons for combinatorial evaluation.",
        parametersOrGates: [
          "Near-Term: 0 to 30 days to expiration (high theta decay, gamma sensitive)",
          "Mid-Term: 31 to 90 days to expiration (optimal swing trading & credit spreads)",
          "Long-Term / LEAPS: 91+ days to expiration (macro directional & calendar spreads)",
        ],
      },
      {
        name: "Hard Exclusion & Liquidity Gates",
        description: "Eliminates low-quality, illiquid, or budget-violating candidates before final ranking.",
        parametersOrGates: [
          "Penny Option Filter: All legs must trade >= $0.05 (unless user selected 'ALL' options mode)",
          "Budget Cap Gate: riskOrCollateral <= userBudget (enforces strict maximum capital limits)",
          "Reward/Risk Gate: (maxProfit / maxLoss) >= minRewardRisk (ensures favorable payoff asymmetry)",
          "Deduplication Gate: Hashes leg signatures ('{side}_{strike}_{type}') to prevent duplicate combinations",
        ],
      },
    ],
    concreteExample: {
      title: "Bullish Spread Discovery on TSLA",
      input: "Symbol: TSLA, Spot: $240.00, Sentiment: Bullish, Budget: $400, Optimization Bias: 70 (Max Chance tilt), Horizon: 35 DTE",
      evaluation: "Engine instantiates Bull Call and Bull Put spreads. Bias 70 shifts strikes 1 step ITM. Generates 235/230 Put Credit Spread (Sell 235P @ $7.20, Buy 230P @ $5.10). Net Credit: $2.10. Max Loss: $2.90 ($290 collateral <= $400 budget).",
      verdict: "PASSED -> Ranked #1 Bullish Candidate with 76.4% POP and $290 max risk.",
    },
  },
  {
    id: "multivariate-scoring-criteria",
    number: 4,
    title: "Multivariate Strategy Scoring & Weighting Vectors",
    subtitle: "Mathematical Formulations for Expected Value, Liquidity, Freshness & OptionStrat Discovery",
    badge: "Mathematical Scoring",
    badgeColor: "purple",
    governedWorkflows: ["A2"],
    overview: "Every candidate strategy is evaluated across a 6-dimensional scoring model in the core engine and a 4-factor composite in the visual Discovery engine. These formulations eliminate subjective bias and rank trades mathematically.",
    rules: [
      {
        name: "Strategy Engine 6-Factor Composite Formulation",
        description: "Calculates overall score S as the dot product of normalized component scores and institutional weights.",
        formulaOrCode: "S = w_thesis*S_thesis + w_RR*S_RR + w_liq*S_liq + w_fresh*S_fresh + w_iv*S_iv + w_theta*S_theta\nWeights: [0.30, 0.20, 0.20, 0.15, 0.10, 0.05]",
      },
      {
        name: "Component 1: Thesis Alignment (w = 0.30)",
        description: "Rewards strategies whose payoff aligns with the target price and expected directional magnitude.",
        formulaOrCode: "If targetPnl > 0 and thesis aligned:\n  S_thesis = clamp(50 + 25 * log2(1 + max(0, targetRewardRisk)))\nElse if thesis aligned:\n  S_thesis = clamp(25 + targetRewardRisk * 10)\nElse: S_thesis = 10",
      },
      {
        name: "Component 2: Target Reward / Risk (w = 0.20)",
        description: "Measures return on risk relative to the user's minimum acceptable reward-to-risk threshold.",
        formulaOrCode: "S_RR = clamp((targetRewardRisk / max(minRewardRisk, 0.25)) * 70)",
      },
      {
        name: "Component 3: Liquidity Score (w = 0.20)",
        description: "Blends bid/ask spread tightness (70% weight) with volume and open interest depth (30% weight) across all legs.",
        formulaOrCode: "spreadScore = clamp(100 - spreadPct * 5)\nactivityScore = clamp(40 + 12 * log10(max(1, vol)) + 8 * log10(max(1, OI)))\nS_liq = mean(0.70 * spreadScore + 0.30 * activityScore)",
      },
      {
        name: "Component 4: Quote Freshness (w = 0.15)",
        description: "Penalizes stale or unverified quotes to prevent recommending unexecutable prices.",
        formulaOrCode: "FRESH (< referenceAgeSeconds): S_fresh = 100\nSTALE (>= referenceAgeSeconds): S_fresh = 25\nUNKNOWN (no timestamp): S_fresh = 0",
      },
      {
        name: "Component 5: Volatility Alignment (w = 0.10)",
        description: "Scores net Vega exposure against expected volatility direction.",
        formulaOrCode: "If expectedIvDirection == 'unchanged': S_iv = 70\nIf expectedIvDirection == 'rise' and netVega >= 0: S_iv = 100 (else 20)\nIf expectedIvDirection == 'fall' and netVega <= 0: S_iv = 100 (else 20)",
      },
      {
        name: "Component 6: Theta Burden (w = 0.05)",
        description: "Protects debit holders against excessive daily time decay relative to total collateral.",
        formulaOrCode: "S_theta = clamp(100 - (max(0, -netTheta) / max(1, maxLoss)) * 10,000)",
      },
    ],
    matrixOrWeights: [
      { dimension: "Thesis Alignment", weightOrValue: "30%", details: "Payoff magnitude at target price & alignment with market outlook" },
      { dimension: "Target Reward / Risk", weightOrValue: "20%", details: "Return on collateral relative to user minimum threshold" },
      { dimension: "Execution Liquidity", weightOrValue: "20%", details: "70% bid/ask spread tightness + 30% log-scaled volume and open interest" },
      { dimension: "Quote Freshness", weightOrValue: "15%", details: "100 pts for fresh real-time quotes, 25 for stale, 0 for unknown" },
      { dimension: "Volatility Alignment", weightOrValue: "10%", details: "Net Vega alignment with expected IV expansion or contraction" },
      { dimension: "Theta Decay Burden", weightOrValue: "5%", details: "Penalizes trades with negative theta burn exceeding collateral thresholds" },
    ],
    concreteExample: {
      title: "Scoring an NVDA Bull Call Spread",
      input: "Target Price: $140.00, Max Loss: $280, Target PnL: $420, Spread: 2.1%, Vol: 4,500, OI: 12,000, Quotes: FRESH",
      evaluation: "S_thesis: 84.2, S_RR: 81.5, S_liq: 88.6, S_fresh: 100.0, S_iv: 70.0, S_theta: 94.0.",
      verdict: "Composite Score: 86.4 / 100 -> Ranks in Top 2% across all evaluated spreads.",
    },
  },
  {
    id: "pickbesttrades-engine",
    number: 5,
    title: "Pick Best Trade Decision Engine (RecommendationAgent)",
    subtitle: "Profile-Weighted Composite Re-Ranking, Blocker Detection, Confidence Grading & Trade Plans",
    badge: "Recommendation Agent",
    badgeColor: "orange",
    governedWorkflows: ["A2", "E1"],
    overview: "The RecommendationAgent re-ranks qualifying strategies against user risk profiles (Conservative, Balanced, Aggressive) and selects a single best trade. It validates blockers, assigns confidence ratings, computes score margins over runner-ups, and formulates an actionable trade plan. Human approval is strictly required before any live execution.",
    rules: [
      {
        name: "Risk Profile Weight Matrices",
        description: "Applies tailored component weights based on the user's explicit risk tolerance.",
        parametersOrGates: [
          "Conservative: 35% Probability (POP) + 20% Capital Safety + 20% Engine Score + 15% Liquidity + 10% Reward/Risk",
          "Balanced: 30% Engine Score + 25% Reward/Risk + 20% Probability + 15% Liquidity + 10% Capital Safety",
          "Aggressive: 45% Reward/Risk + 25% Engine Score + 20% Liquidity + 10% Probability + 0% Capital Safety",
        ],
      },
      {
        name: "Hard Trade Blockers & Status Degradation",
        description: "Identifies blocking conditions that degrade status from 'recommended' to 'research_only' or 'no_trade'.",
        parametersOrGates: [
          "No Candidates: If no candidate satisfies criteria -> status: 'no_trade', confidence: 'LOW'",
          "Stale Market Data: If quoteFreshness != 'FRESH' -> Blocker: 'Quote data is STALE'; confidence downgraded to 'LOW'",
          "Zero/Negative Profit: If maxProfit <= 0 after estimated fees -> Blocker: 'No positive maximum profit after fees'",
          "Deficient Win Rate: If POP < 20% -> Blocker: 'Model-implied probability of profit is below 20%'",
        ],
      },
      {
        name: "Confidence Rating Grading",
        description: "Assigns institutional confidence based on score margin over runner-up, execution liquidity, and win probability.",
        formulaOrCode: "If dataFreshness != 'FRESH' or blockers.length > 0:\n  confidence = 'LOW'\nElse if margin_over_runner_up >= 5.0 and liquidityScore >= 60 and POP >= 35%:\n  confidence = 'HIGH'\nElse:\n  confidence = 'MEDIUM'",
      },
      {
        name: "Executable Multi-Leg Trade Plan",
        description: "Extracts contract-level trade ticket instructions with exact limit prices and broker parameters.",
        parametersOrGates: [
          "Action: BUY / SELL / BUY_TO_COVER / SELL_SHORT",
          "Quantity: Leg multiplier count",
          "Contract: Full OSI contract symbol",
          "Option Type: CALL / PUT / STOCK",
          "Strike & Expiration Date",
          "Limit Price: Conservative ask-side entry for buys, bid-side for sells",
          "Human-in-the-Loop Guard: humanApprovalRequired = true",
        ],
      },
    ],
    matrixOrWeights: [
      { dimension: "Conservative Weights", weightOrValue: "35% POP · 20% Safety · 20% Engine · 15% Liq · 10% R:R", details: "Pushes wide credit spreads and deep ITM debits with high win rate and capital buffer" },
      { dimension: "Balanced Weights", weightOrValue: "30% Engine · 25% R:R · 20% POP · 15% Liq · 10% Safety", details: "Pareto balance maximizing expected value (EV) and risk-adjusted return" },
      { dimension: "Aggressive Weights", weightOrValue: "45% R:R · 25% Engine · 20% Liq · 10% POP · 0% Safety", details: "Prioritizes asymmetric out-of-the-money debit spreads with maximum leverage" },
    ],
    concreteExample: {
      title: "Selecting the Best Trade on SPY",
      input: "Symbol: SPY, Target: $585.00, Max Loss: $500, Risk Profile: Balanced, Candidates Evaluated: 18",
      evaluation: "Rank 1: SPY 575/580 Call Spread (Score: 84.2). Rank 2: SPY 570/575 Call Spread (Score: 78.1). Margin: +6.1 points. Liquidity: 92/100. POP: 64.2%. Quotes: FRESH.",
      verdict: "Status: 'recommended', Confidence: 'HIGH'. Trade Plan: Buy 1x SPY 575C @ $5.80, Sell 1x SPY 580C @ $3.20 (Net Debit: $2.60).",
    },
  },
  {
    id: "additional-decisioning-gates",
    number: 6,
    title: "Additional Decisioning Gates, Exclusion Rules & Background Automation",
    subtitle: "Undefined Risk Safeguards, Arbitrage Rejection, Autonomous Schedulers & Brokerage Handshake",
    badge: "Execution Safeguards",
    badgeColor: "cyan",
    governedWorkflows: ["A6", "E1", "E3", "E5"],
    overview: "To guarantee regulatory compliance, capital protection, and unattended stability, the platform enforces hard exclusion gates across strategy catalogs, options tape parsing, background schedulers, and live brokerage placement.",
    rules: [
      {
        name: "Undefined Risk Exclusion Gate",
        description: "Rejects strategies with uncapped catastrophic loss potential when operating under defined-risk policies.",
        formulaOrCode: "If riskPolicy == 'defined_only' and maxLoss == null (or unbounded):\n  candidate.rejected = true\n  rejectionReason = 'UNDEFINED_RISK_PROHIBITED'\n- Omits naked short calls, naked short puts, short straddles, and short strangles",
      },
      {
        name: "Apparent Riskless Profit Arbitrage Gate",
        description: "Eliminates synthetic combinations that display constant positive profit across all price steps.",
        formulaOrCode: "If expiryPnl is flat and > 0 across all prices:\n  candidate.rejected = true\n  rejectionReason = 'Apparent riskless profit almost always indicates stale/crossed quotes or unmodeled borrow and carry risk'",
      },
      {
        name: "Autonomous Opportunity Scanner Target Multipliers",
        description: "Applies standardized price target projections when running autonomous background scans without human prompts.",
        parametersOrGates: [
          "bullish: 1.05 (+5.0% price target projection from current spot)",
          "bearish: 0.95 (-5.0% price target projection from current spot)",
          "large_move: 1.10 (+10.0% directional volatility expansion projection)",
          "range_bound: 1.00 (Pins price target directly to current spot price)",
        ],
      },
      {
        name: "Options Tape Sentiment Aggressiveness Gate",
        description: "Classifies live institutional sweeps and blocks based on execution price relative to prevailing bid/ask quotes.",
        formulaOrCode: "Execution Price >= Ask -> Aggressive Buyer (+Dollar Premium to Bullish for Calls, Bearish for Puts)\nExecution Price <= Bid -> Aggressive Seller (+Dollar Premium to Bearish for Calls, Bullish for Puts)\nMidpoint -> Split venue execution; neutral weighting",
      },
      {
        name: "Brokerage Human-in-the-Loop (HITL) Execution Guard",
        description: "Enforces two-phase cryptographic preview validation before submitting orders to E*TRADE.",
        parametersOrGates: [
          "Phase 1 (Preview): Broker validates margins, balances, and returns previewId",
          "HITL Gate: Halts execution completely. Renders amber confirmation card with commission and total cost impact",
          "Phase 2 (Place): Submits previewId with fresh clientOrderId only upon authenticated human trader click",
          "Zero Autonomous Execution: AI agents cannot place live orders without human authorization",
        ],
      },
    ],
    concreteExample: {
      title: "Blocking an Unhedged Naked Short Call",
      input: "Strategy: Short Call on NVDA 135C with net credit of $4.20. Risk Policy: 'defined_only'.",
      evaluation: "Engine detects netHighSlope < 0 (unbounded upside loss). Max Loss = Infinity.",
      verdict: "REJECTED -> Logged in Strategy Rejection Ledger as 'UNDEFINED_RISK_PROHIBITED'. Never presented to user as viable candidate.",
    },
  },
];
