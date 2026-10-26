"use client";

import { ArrowDownLeft, ArrowUpRight, ChevronDown, Command, MoreHorizontal } from "lucide-react";
import { useState } from "react";

const PERIODS = {
  month: {
    balance: "$12,684.50",
    change: "+8.2%",
    income: "$4,850",
    spending: "$2,164",
    label: "This month",
    path: "M0 95C18 94 24 102 42 85S67 91 85 65S110 79 128 55S150 75 170 46S193 63 214 38S242 55 263 28S290 44 311 19S339 31 360 8",
    dates: ["Oct 1", "Oct 8", "Oct 15", "Oct 22", "Oct 31"],
  },
  year: {
    balance: "$48,260.80",
    change: "+24.6%",
    income: "$58,200",
    spending: "$25,971",
    label: "This year",
    path: "M0 108C20 101 25 112 46 97S71 106 91 84S120 95 141 76S164 84 186 60S215 71 235 49S265 57 285 32S313 43 334 18S350 18 360 5",
    dates: ["Jan", "Apr", "Jul", "Oct", "Dec"],
  },
};

/** An interactive example app, scoped to the product walkthrough. */
export function AppPreview() {
  const [period, setPeriod] = useState<keyof typeof PERIODS>("month");
  const data = PERIODS[period];
  return (
    <div className="ps-ledger">
      <aside className="ps-ledger-sidebar" aria-hidden="true">
        <span className="ps-ledger-logo">
          <Command size={16} /> ledger
        </span>
        <span className="ps-ledger-selected">Overview</span>
        <span>Transactions</span>
        <span>Accounts</span>
        <span>Settings</span>
        <span className="ps-ledger-user">
          <i>J</i> James Cooper
        </span>
      </aside>
      <div className="ps-ledger-main">
        <div className="ps-ledger-topline">
          <span>
            Overview <ChevronDown size={10} />
          </span>
          <span className="ps-ledger-avatar">J</span>
        </div>
        <div className="ps-ledger-heading">
          <div>
            <span>YOUR MONEY, A LITTLE CLEARER.</span>
            <h3>Room to do more.</h3>
          </div>
          <fieldset className="ps-periods" aria-label="Dashboard period">
            <button
              type="button"
              aria-pressed={period === "month"}
              onClick={() => setPeriod("month")}
            >
              Month
            </button>
            <button
              type="button"
              aria-pressed={period === "year"}
              onClick={() => setPeriod("year")}
            >
              Year
            </button>
          </fieldset>
        </div>
        <div className="ps-ledger-stats">
          <div>
            <span>Total balance</span>
            <strong>{data.balance}</strong>
            <small>
              {data.change} <span>this period</span>
            </small>
          </div>
          <div>
            <span>
              <ArrowDownLeft size={11} /> Income
            </span>
            <strong>{data.income}</strong>
            <small>Across your accounts</small>
          </div>
          <div>
            <span>
              <ArrowUpRight size={11} /> Spending
            </span>
            <strong>{data.spending}</strong>
            <small>{data.label}</small>
          </div>
        </div>
        <div className="ps-ledger-detail">
          <div className="ps-ledger-chart">
            <div>
              <b>Balance over time</b>
              <span>
                {data.label} <ChevronDown size={10} />
              </span>
            </div>
            <div className="ps-chart-canvas">
              <span className="ps-chart-grid" aria-hidden="true" />
              <svg
                key={period}
                viewBox="0 0 360 120"
                role="img"
                aria-label={`Balance trend for ${data.label.toLowerCase()}`}
                preserveAspectRatio="none"
              >
                <title>Balance trend</title>
                <path className="ps-chart-fill" d={`${data.path}L360 120H0Z`} />
                <path className="ps-chart-line" d={data.path} />
              </svg>
            </div>
            <div className="ps-chart-dates">
              {data.dates.map((date) => (
                <span key={date}>{date}</span>
              ))}
            </div>
          </div>
          <div className="ps-ledger-transactions">
            <div>
              <b>Recent activity</b>
              <MoreHorizontal size={14} />
            </div>
            <span>
              <i className="ps-transaction-icon">F</i>
              <span>
                Freelance project<small>Today · Transfer</small>
              </span>
              <strong>+$1,250.00</strong>
            </span>
            <span>
              <i className="ps-transaction-icon">↗</i>
              <span>
                Notion<small>Yesterday · Software</small>
              </span>
              <strong>−$12.00</strong>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
