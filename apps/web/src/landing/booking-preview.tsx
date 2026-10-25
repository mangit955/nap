"use client";

import { useState } from "react";
import { CheckIcon } from "../ui/icons.tsx";

export function BookingPreview() {
  const [arrival, setArrival] = useState(6);
  const [nights, setNights] = useState<2 | 3 | 4>(2);
  const [confirmed, setConfirmed] = useState(false);
  const total = nights * 195;
  return (
    <div className="lp-booking-app">
      <div className="lp-booking-nav">
        <span>still.</span>
        <span>A little closer to nowhere.</span>
        <span>STAYS / 01</span>
      </div>
      <div className="lp-booking-photo">
        <div>
          <span>THE HIGHLANDS, SCOTLAND</span>
          <p className="lp-serif">
            A quieter
            <br />
            kind of weekend.
          </p>
        </div>
        <span>01 / THE HEATHER CABIN</span>
      </div>
      <div className="lp-booking-content">
        <div className="lp-booking-intro">
          <div>
            <span>YOUR OWN CORNER OF THE HIGHLANDS</span>
            <p className="lp-serif">The Heather Cabin</p>
            <small>2 guests · 1 bedroom · Nothing on the agenda.</small>
          </div>
          <div>
            <b>$195</b>
            <span> / night</span>
          </div>
        </div>
        {confirmed ? (
          <div className="lp-booking-confirmation" role="status">
            <span>
              <CheckIcon className="size-6" />
            </span>
            <p className="lp-serif">A little time, just for you.</p>
            <div>
              November {arrival} to {arrival + nights} · {nights} nights
            </div>
            <strong>${total} total</strong>
            <small>Demo booking confirmed. No reservation is created.</small>
            <button type="button" onClick={() => setConfirmed(false)}>
              Choose another stay ↗
            </button>
          </div>
        ) : (
          <>
            <div className="lp-booking-date-label">
              <span>Choose your arrival</span>
              <span>NOVEMBER 2026</span>
            </div>
            <fieldset className="lp-booking-dates" aria-label="Arrival date">
              {[6, 7, 8, 9, 10, 11, 12].map((day, index) => (
                <button
                  key={day}
                  type="button"
                  aria-label={`Arrive November ${day}`}
                  aria-pressed={arrival === day}
                  onClick={() => setArrival(day)}
                >
                  <span>{["FRI", "SAT", "SUN", "MON", "TUE", "WED", "THU"][index]}</span>
                  <b>{day}</b>
                </button>
              ))}
            </fieldset>
            <div className="lp-booking-options">
              <label>
                Stay a little longer
                <select
                  aria-label="Length of stay"
                  value={nights}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (value === 2 || value === 3 || value === 4) setNights(value);
                  }}
                >
                  <option value="2">2 nights</option>
                  <option value="3">3 nights</option>
                  <option value="4">4 nights</option>
                </select>
              </label>
              <span>
                November {arrival} to {arrival + nights}
                <br />
                <small>${total} total · 2 guests</small>
              </span>
            </div>
            <button type="button" className="lp-booking-reserve" onClick={() => setConfirmed(true)}>
              Reserve your quiet <span aria-hidden="true">↗</span>
            </button>
            <p className="lp-booking-footnote">An interactive example built with nap.</p>
          </>
        )}
      </div>
    </div>
  );
}
