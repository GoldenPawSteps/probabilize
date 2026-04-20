import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import Decimal from 'decimal.js'
import './App.css'

type User = {
  id: string
  name: string
  balance: Decimal
  shares: Record<string, Decimal[]>
}

type Market = {
  id: string
  makerId: string
  outcomes: string[]
  prior: Decimal[]
  b: Decimal
  L: Decimal
  qMaker: Decimal[]
}

type MakeValidation = {
  error: string | null
  outcomes: string[]
  prior: Decimal[]
  b: Decimal | null
  L: Decimal | null
}

type TradePreview = {
  error: string | null
  adjusted: Decimal[]
  deltaCost: Decimal
}

const ONE = new Decimal(1)
const ZERO = new Decimal(0)

const formatDecimal = (value: Decimal, dp = 8) => value.toDecimalPlaces(dp).toString()

const zeroVector = (length: number) => Array.from({ length }, () => new Decimal(0))

const parseDecimalVector = (raw: string) => {
  const parts = raw
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  if (parts.length === 0) {
    return { error: 'Provide a comma-separated numeric vector.' }
  }

  try {
    const values = parts.map((part) => new Decimal(part))
    return { values }
  } catch {
    return { error: 'All vector entries must be valid numbers.' }
  }
}

const parseOutcomeVector = (raw: string) => {
  const outcomes = raw
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  if (outcomes.length < 2) {
    return { error: 'Provide at least two outcomes.' }
  }

  if (new Set(outcomes).size !== outcomes.length) {
    return { error: 'Outcomes must be unique.' }
  }

  return { outcomes }
}

const dotProduct = (left: Decimal[], right: Decimal[]) =>
  left.reduce((acc, value, index) => acc.plus(value.times(right[index])), new Decimal(0))

const logWeightedExp = (weights: Decimal[], scaledValues: Decimal[]) => {
  const maxScaled = Decimal.max(...scaledValues)
  const normalized = scaledValues.reduce(
    (acc, value, index) => acc.plus(weights[index].times(value.minus(maxScaled).exp())),
    new Decimal(0),
  )

  return {
    logValue: maxScaled.plus(normalized.ln()),
    maxScaled,
    normalized,
  }
}

const cost = (market: Market, q: Decimal[]) => {
  const scaled = q.map((qValue) => qValue.div(market.b))
  const { logValue } = logWeightedExp(market.prior, scaled)

  return market.L.plus(market.b.times(logValue))
}

const impliedProbabilities = (market: Market, q: Decimal[]) => {
  const scaled = q.map((qValue) => qValue.div(market.b))
  const { maxScaled, normalized } = logWeightedExp(market.prior, scaled)
  const numerators = scaled.map((value, index) => market.prior[index].times(value.minus(maxScaled).exp()))

  return numerators.map((value) => value.div(normalized))
}

const adjustDelta = (qTaker: Decimal[], delta: Decimal[]) => {
  const postTrade = qTaker.map((value, index) => value.plus(delta[index]))
  const minPostTrade = Decimal.min(...postTrade)

  return delta.map((value) => value.minus(minPostTrade))
}

const getUserShares = (user: User, marketId: string, outcomeCount: number) =>
  user.shares[marketId] ? [...user.shares[marketId]] : zeroVector(outcomeCount)

function App() {
  const [users, setUsers] = useState<User[]>([])
  const [markets, setMarkets] = useState<Market[]>([])
  const [activeUserId, setActiveUserId] = useState<string | null>(null)

  const [registerName, setRegisterName] = useState('')
  const [marketOutcomes, setMarketOutcomes] = useState('YES, NO')
  const [marketPrior, setMarketPrior] = useState('0.5, 0.5')
  const [marketB, setMarketB] = useState('1')
  const [tradeInputs, setTradeInputs] = useState<Record<string, string>>({})

  const activeUser = activeUserId ? users.find((user) => user.id === activeUserId) ?? null : null

  const makeValidation: MakeValidation = useMemo(() => {
    if (!activeUser) {
      return {
        error: 'Register at least one user first.',
        outcomes: [],
        prior: [],
        b: null,
        L: null,
      }
    }

    const parsedOutcomes = parseOutcomeVector(marketOutcomes)
    if ('error' in parsedOutcomes) {
      return { error: parsedOutcomes.error ?? 'Invalid outcomes.', outcomes: [], prior: [], b: null, L: null }
    }

    const parsedPrior = parseDecimalVector(marketPrior)
    if ('error' in parsedPrior) {
      return { error: parsedPrior.error ?? 'Invalid prior vector.', outcomes: parsedOutcomes.outcomes, prior: [], b: null, L: null }
    }

    const prior = parsedPrior.values
    if (!prior || prior.length !== parsedOutcomes.outcomes.length) {
      return {
        error: 'Prior vector must match outcomes length.',
        outcomes: parsedOutcomes.outcomes,
        prior: [],
        b: null,
        L: null,
      }
    }

    const nonPositive = prior.some((value) => value.lte(ZERO))
    if (nonPositive) {
      return {
        error: 'All prior probabilities must be strictly positive.',
        outcomes: parsedOutcomes.outcomes,
        prior,
        b: null,
        L: null,
      }
    }

    const sum = prior.reduce((acc, value) => acc.plus(value), new Decimal(0))
    if (!sum.eq(ONE)) {
      return {
        error: 'Prior probabilities must sum to exactly 1.',
        outcomes: parsedOutcomes.outcomes,
        prior,
        b: null,
        L: null,
      }
    }

    let b: Decimal
    try {
      b = new Decimal(marketB)
    } catch {
      return {
        error: 'Liquidity parameter b must be a valid number.',
        outcomes: parsedOutcomes.outcomes,
        prior,
        b: null,
        L: null,
      }
    }

    if (b.lte(ZERO)) {
      return {
        error: 'Liquidity parameter b must be > 0.',
        outcomes: parsedOutcomes.outcomes,
        prior,
        b,
        L: null,
      }
    }

    const minPrior = Decimal.min(...prior)
    const L = b.negated().times(minPrior.ln())

    if (activeUser.balance.lt(L)) {
      return {
        error: `Maker balance is insufficient. Need L = ${formatDecimal(L)}.`,
        outcomes: parsedOutcomes.outcomes,
        prior,
        b,
        L,
      }
    }

    return {
      error: null,
      outcomes: parsedOutcomes.outcomes,
      prior,
      b,
      L,
    }
  }, [activeUser, marketB, marketOutcomes, marketPrior])

  const registerUser = (event: FormEvent) => {
    event.preventDefault()

    const trimmed = registerName.trim()
    if (!trimmed) {
      return
    }

    const alreadyExists = users.some((user) => user.name.toLowerCase() === trimmed.toLowerCase())
    if (alreadyExists) {
      return
    }

    const user: User = {
      id: crypto.randomUUID(),
      name: trimmed,
      balance: new Decimal(1),
      shares: Object.fromEntries(markets.map((market) => [market.id, zeroVector(market.outcomes.length)])),
    }

    setUsers((current) => [...current, user])
    setActiveUserId(user.id)
    setRegisterName('')
  }

  const createMarket = () => {
    if (!activeUser || makeValidation.error || !makeValidation.b || !makeValidation.L) {
      return
    }

    const newMarket: Market = {
      id: crypto.randomUUID(),
      makerId: activeUser.id,
      outcomes: makeValidation.outcomes,
      prior: makeValidation.prior,
      b: makeValidation.b,
      L: makeValidation.L,
      qMaker: zeroVector(makeValidation.outcomes.length),
    }

    setUsers((current) =>
      current.map((user) => {
        const nextShares = {
          ...user.shares,
          [newMarket.id]: zeroVector(makeValidation.outcomes.length),
        }

        if (user.id !== activeUser.id) {
          return {
            ...user,
            shares: nextShares,
          }
        }

        return {
          ...user,
          balance: user.balance.minus(makeValidation.L as Decimal),
          shares: nextShares,
        }
      }),
    )

    setMarkets((current) => [newMarket, ...current])
    setTradeInputs((current) => ({ ...current, [newMarket.id]: zeroVector(newMarket.outcomes.length).join(', ') }))
  }

  const getTradePreview = (market: Market, trader: User | null, rawDelta: string): TradePreview => {
    if (!trader) {
      return { error: 'Select or register a user first.', adjusted: zeroVector(market.outcomes.length), deltaCost: ZERO }
    }

    if (trader.id === market.makerId) {
      return { error: 'Maker cannot take their own market.', adjusted: zeroVector(market.outcomes.length), deltaCost: ZERO }
    }

    const parsed = parseDecimalVector(rawDelta)
    if ('error' in parsed) {
      return { error: parsed.error ?? 'Invalid trade vector.', adjusted: zeroVector(market.outcomes.length), deltaCost: ZERO }
    }

    const delta = parsed.values
    if (!delta || delta.length !== market.outcomes.length) {
      return {
        error: `Trade vector must have ${market.outcomes.length} values.`,
        adjusted: zeroVector(market.outcomes.length),
        deltaCost: ZERO,
      }
    }

    const qTaker = getUserShares(trader, market.id, market.outcomes.length)
    const adjusted = adjustDelta(qTaker, delta)
    const nextQMaker = market.qMaker.map((value, index) => value.plus(adjusted[index]))
    const deltaCost = cost(market, nextQMaker).minus(cost(market, market.qMaker))

    if (trader.balance.lt(deltaCost)) {
      return {
        error: `Insufficient balance. Need ΔC = ${formatDecimal(deltaCost)}.`,
        adjusted,
        deltaCost,
      }
    }

    return {
      error: null,
      adjusted,
      deltaCost,
    }
  }

  const executeTrade = (market: Market) => {
    const trader = activeUser
    const rawDelta = tradeInputs[market.id] ?? ''
    const preview = getTradePreview(market, trader, rawDelta)

    if (!trader || preview.error) {
      return
    }

    setMarkets((current) =>
      current.map((entry) => {
        if (entry.id !== market.id) {
          return entry
        }

        return {
          ...entry,
          qMaker: entry.qMaker.map((value, index) => value.plus(preview.adjusted[index])),
        }
      }),
    )

    setUsers((current) =>
      current.map((user) => {
        if (user.id !== trader.id) {
          return user
        }

        const currentShares = getUserShares(user, market.id, market.outcomes.length)

        return {
          ...user,
          balance: user.balance.minus(preview.deltaCost),
          shares: {
            ...user.shares,
            [market.id]: currentShares.map((value, index) => value.plus(preview.adjusted[index])),
          },
        }
      }),
    )
  }

  const unmakeMarket = (market: Market) => {
    if (!activeUser || activeUser.id !== market.makerId) {
      return
    }

    const gradient = impliedProbabilities(market, market.qMaker)
    const makerRefund = cost(market, market.qMaker).minus(dotProduct(gradient, market.qMaker))

    setUsers((current) =>
      current.map((user) => {
        if (user.id === market.makerId) {
          return {
            ...user,
            balance: user.balance.plus(makerRefund),
            shares: {
              ...user.shares,
              [market.id]: zeroVector(market.outcomes.length),
            },
          }
        }

        const takerShares = getUserShares(user, market.id, market.outcomes.length)
        const payout = dotProduct(gradient, takerShares)

        return {
          ...user,
          balance: user.balance.plus(payout),
          shares: {
            ...user.shares,
            [market.id]: zeroVector(market.outcomes.length),
          },
        }
      }),
    )

    setMarkets((current) => current.filter((entry) => entry.id !== market.id))
  }

  return (
    <main className="app-shell">
      <header className="panel">
        <div>
          <h1>Probabilize</h1>
          <p className="muted">Decentralized-style probability market simulator</p>
        </div>
        <div className="balance-box">
          <label>
            Active user
            <select
              value={activeUserId ?? ''}
              onChange={(event) => setActiveUserId(event.target.value || null)}
              aria-label="Active user"
            >
              <option value="">None</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </label>
          <span className="balance-value">B = {activeUser ? formatDecimal(activeUser.balance) : '1'}</span>
        </div>
      </header>

      <section className="grid">
        <article className="panel">
          <h2>Register</h2>
          <form className="stack" onSubmit={registerUser}>
            <input
              value={registerName}
              onChange={(event) => setRegisterName(event.target.value)}
              placeholder="User name"
              aria-label="User name"
            />
            <button type="submit">Register (B = 1)</button>
          </form>

          <ul className="user-list">
            {users.map((user) => (
              <li key={user.id} className={activeUser?.id === user.id ? 'active' : ''}>
                <span>{user.name}</span>
                <span>{formatDecimal(user.balance)}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Make a market</h2>
          <div className="stack">
            <label>
              Outcomes ω
              <input
                value={marketOutcomes}
                onChange={(event) => setMarketOutcomes(event.target.value)}
                placeholder="YES, NO"
              />
            </label>
            <label>
              Prior p
              <input
                value={marketPrior}
                onChange={(event) => setMarketPrior(event.target.value)}
                placeholder="0.5, 0.5"
              />
            </label>
            <label>
              Liquidity b
              <input value={marketB} onChange={(event) => setMarketB(event.target.value)} placeholder="1" />
            </label>
            <p className="formula">L = -b ln(min(p)) = {makeValidation.L ? formatDecimal(makeValidation.L) : '—'}</p>
            {makeValidation.error ? <p className="error">{makeValidation.error}</p> : <p className="ok">Market valid.</p>}
            <button type="button" disabled={Boolean(makeValidation.error)} onClick={createMarket}>
              Make market
            </button>
          </div>
        </article>
      </section>

      <section className="markets">
        <h2>Active markets</h2>
        {markets.length === 0 && <p className="muted">No active markets yet.</p>}

        {markets.map((market) => {
          const maker = users.find((user) => user.id === market.makerId)
          const probs = impliedProbabilities(market, market.qMaker)
          const rawDelta = tradeInputs[market.id] ?? ''
          const preview = getTradePreview(market, activeUser, rawDelta)

          return (
            <article key={market.id} className="panel market-card">
              <div className="market-head">
                <div>
                  <h3>{market.outcomes.join(' / ')}</h3>
                  <p className="muted">Maker: {maker?.name ?? 'Unknown'} · b = {formatDecimal(market.b)}</p>
                </div>
                {activeUser?.id === market.makerId && (
                  <button type="button" onClick={() => unmakeMarket(market)}>
                    Unmake market
                  </button>
                )}
              </div>

              <ul className="prob-list">
                {market.outcomes.map((outcome, index) => (
                  <li key={`${market.id}-${outcome}`}>
                    <span>{outcome}</span>
                    <strong>{formatDecimal(probs[index].times(100), 4)}%</strong>
                  </li>
                ))}
              </ul>

              <p className="formula">
                C(q) = L + b ln(Σ pᵢe^(qᵢ/b)) = {formatDecimal(cost(market, market.qMaker))}
              </p>

              <div className="trade-box">
                <label>
                  Δq
                  <input
                    value={rawDelta}
                    onChange={(event) =>
                      setTradeInputs((current) => ({
                        ...current,
                        [market.id]: event.target.value,
                      }))
                    }
                    placeholder={zeroVector(market.outcomes.length).join(', ')}
                  />
                </label>
                <p className="formula">ΔC = {formatDecimal(preview.deltaCost)}</p>
                <p className="formula">Δq' = [{preview.adjusted.map((value) => formatDecimal(value, 4)).join(', ')}]</p>
                {preview.error ? <p className="error">{preview.error}</p> : <p className="ok">Trade valid.</p>}
                <button type="button" disabled={Boolean(preview.error)} onClick={() => executeTrade(market)}>
                  Take market
                </button>
              </div>
            </article>
          )
        })}
      </section>
    </main>
  )
}

export default App
