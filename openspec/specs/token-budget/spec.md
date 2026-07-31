# token-budget Specification

## Purpose

Budget enforcement for the token management system: resolve requested models against the user's token balance before execution, route paid requests to free Zen models when the balance is exhausted, deduct real usage after completion, and surface budget exhaustion as an upsell message.

## Requirements

### Requirement: Pre-Request Model Resolution

When a user initiates an LLM request, the system MUST resolve the requested model against the user's current token balance before executing the request.

Zen models (where `providerID.startsWith("opencode")`) MUST always pass without balance check.

For paid models, the system MUST check the user's current balance. If balance is ≤ 0, the system MUST attempt to find an available Zen model from the same provider family. If a Zen model is available, the system SHOULD substitute it transparently. If no Zen model is available, the system MUST fail with `BudgetExhaustedError`.

#### Scenario: Paid model with sufficient balance

- GIVEN user has balance > 0
- WHEN a paid model is requested
- THEN the original model proceeds to execution
- AND no model swap occurs

#### Scenario: Paid model with zero balance, Zen fallback available

- GIVEN user has balance ≤ 0
- AND a Zen model exists for the same family
- WHEN a paid model is requested
- THEN the request is transparently routed to the Zen model
- AND no balance deduction occurs

#### Scenario: Paid model with zero balance, no Zen fallback

- GIVEN user has balance ≤ 0
- AND no Zen model is available
- WHEN a paid model is requested
- THEN `BudgetExhaustedError` is raised
- AND the error includes `message` suitable for upsell

#### Scenario: Zen model requested

- GIVEN user has balance = 0
- WHEN a Zen model (`providerID.startsWith("opencode")`) is requested
- THEN the request proceeds without balance check
- AND no deduction occurs

### Requirement: Post-Request Usage Deduction

After an LLM response completes, the system MUST deduct the real usage cost from the user's token balance and record the transaction.

#### Scenario: Successful paid completion

- GIVEN a paid model was used for the request
- AND `Session.getUsage()` returns real token/cost data
- WHEN `step-finish` event fires
- THEN the system deducts `usage.cost` from the user's `token_balance`
- AND appends a row to `token_transaction` with `amount = -cost`, `model`, `tokensUsed`, `costUsd`

#### Scenario: Deduction with insufficient remaining balance

- GIVEN paid model usage exceeds remaining balance
- WHEN deduction is attempted
- THEN balance MAY go negative (no hard block on deduction)
- AND the transaction is still recorded

### Requirement: Free-First Routing

Free models (providerID starts with "opencode") MUST never trigger balance deduction.

#### Scenario: Zen model, no deduction

- GIVEN a Zen model processes a request
- WHEN the request completes
- THEN `deduct` MUST NOT be called
- AND no transaction row is created

### Requirement: BudgetExhaustedError Integration

The `BudgetExhaustedError` MUST propagate through the session retry system as an upsell message.

#### Scenario: Budget exhausted in session

- GIVEN `BudgetExhaustedError` is raised during a session
- WHEN the error reaches the retry handler
- THEN the message `"Free usage exceeded, subscribe to Go"` SHOULD be displayed
- AND the user sees a link to `https://opencode.ai/go`

### Requirement: Monthly Auto-Recharge

On first login of each UTC month, the system MUST credit the user's token balance with the monthly allowance and record the credit transaction.

The allowance MUST be read from `OPENCODE_MONTHLY_ALLOWANCE` (default 50000). The system MUST track `last_allowance_month` on the user's `token_balance` row and MUST NOT credit a user more than once per month.

#### Scenario: First login of the month credits allowance

- GIVEN a user logs in for the first time in UTC month `YYYY-MM`
- AND `last_allowance_month` is empty or older than `YYYY-MM`
- WHEN `upsertFromAuth` completes the identity upsert
- THEN the balance is increased by the allowance
- AND `last_allowance_month` is set to `YYYY-MM`
- AND a `token_transaction` row is inserted with a positive `amount` and description `Monthly allowance YYYY-MM`

#### Scenario: Second login of the same month does not double-credit

- GIVEN `last_allowance_month` equals the current UTC month
- WHEN a user logs in again in the same month
- THEN no allowance is credited
- AND no additional transaction row is created

### Requirement: Low-Balance Warning

After a successful deduction, if the resulting balance is positive but below the low-balance threshold, the system MUST emit a warning that is surfaced to the user in the LLM response.

The threshold MUST be read from `OPENCODE_LOW_BALANCE_THRESHOLD` or computed as `max(5000, allowance * 0.2)`.

#### Scenario: Balance drops below threshold after deduction

- GIVEN a paid model request completes
- AND the post-deduction balance is `> 0` but `< threshold`
- WHEN `deduct` finishes
- THEN a warning with the remaining balance is set
- AND the warning is appended to the assistant message in `step-finish`

#### Scenario: Balance stays above threshold

- GIVEN a paid model request completes
- AND the post-deduction balance is `>= threshold`
- WHEN `deduct` finishes
- THEN no warning is emitted

### Requirement: Admin Stats Endpoints

The system MUST expose admin-only HTTP endpoints returning aggregated token usage statistics.

`GET /admin/stats` MUST return current totals: total users, total balance, and total consumption for the current month. `GET /admin/stats/usage?from=YYYY-MM-DD&to=YYYY-MM-DD` MUST return a daily per-user breakdown of consumption (tokens used, cost USD, request count) within the date range.

#### Scenario: Admin requests current totals

- GIVEN an authenticated admin user
- WHEN `GET /admin/stats` is requested
- THEN the response contains `totalUsers`, `totalBalance`, and `totalUsedThisMonth`

#### Scenario: Admin requests daily usage breakdown

- GIVEN an authenticated admin user
- AND a date range `from`/`to` is provided
- WHEN `GET /admin/stats/usage` is requested
- THEN the response contains one entry per user per day with `date`, `userId`, `email`, `tokensUsed`, `costUsd`, `requestCount`
