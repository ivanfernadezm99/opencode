# Delta for token-budget

## ADDED Requirements

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
