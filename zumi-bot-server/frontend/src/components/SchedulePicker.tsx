import { useState } from 'react'
import type { Schedule } from '@zumibot/shared/routines'
import { cronPreview, daysPillLabel, FREQS, fromClock12, scheduleForFreq, timePillLabel, toClock12, type Freq } from '../state/routineDraft'
import { useDismiss } from '../useDismiss'
import { Caret } from './Caret'
import { RoutineIcon } from './RoutineIcons'
import { SearchSelect } from './SearchSelect'

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** A pill that opens a small popover. The wrapper stops mousedown so useDismiss only closes on outside clicks. */
function Pill({ label, testId, icon, children }: { label: string; testId: string; icon?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  useDismiss(open, () => setOpen(false))
  return (
    <span className="rt-pop-wrap" onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className="rt-pill rt-pick" data-testid={testId} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {icon && <RoutineIcon name="clock" />}
        <span>{label}</span>
        <Caret />
      </button>
      {open && <div className="rt-pop">{children}</div>}
    </span>
  )
}

function TimePicker({ time, onChange }: { time: string; onChange: (t: string) => void }) {
  const c = toClock12(time)
  return (
    <Pill label={timePillLabel(time)} testId="schedule-time" icon>
      <div className="rt-time">
        <SearchSelect
          className="rt-num"
          data-testid="time-hour"
          aria-label="Hour"
          value={c.hour}
          onChange={(v) => onChange(fromClock12({ ...c, hour: +v }))}
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </SearchSelect>
        <span>:</span>
        <SearchSelect
          className="rt-num"
          data-testid="time-minute"
          aria-label="Minute"
          value={c.minute}
          onChange={(v) => onChange(fromClock12({ ...c, minute: +v }))}
        >
          {Array.from({ length: 60 }, (_, i) => i).map((m) => (
            <option key={m} value={m}>
              {String(m).padStart(2, '0')}
            </option>
          ))}
        </SearchSelect>
        <span className="rt-ampm">
          <button type="button" data-testid="time-am" aria-pressed={!c.pm} onClick={() => onChange(fromClock12({ ...c, pm: false }))}>
            AM
          </button>
          <button type="button" data-testid="time-pm" aria-pressed={c.pm} onClick={() => onChange(fromClock12({ ...c, pm: true }))}>
            PM
          </button>
        </span>
      </div>
    </Pill>
  )
}

function DaysPicker({ days, onChange }: { days: number[]; onChange: (d: number[]) => void }) {
  const toggle = (d: number): void => {
    if (days.includes(d)) {
      if (days.length > 1) onChange(days.filter((x) => x !== d)) // a schedule needs at least one day
    } else onChange([...days, d].sort((a, b) => a - b))
  }
  return (
    <Pill label={daysPillLabel(days)} testId="schedule-days">
      <div className="rt-days">
        {DAY_LETTERS.map((l, d) => (
          <button
            key={d}
            type="button"
            data-testid={`day-${d}`}
            aria-pressed={days.includes(d)}
            aria-label={WEEKDAYS[d]}
            onClick={() => toggle(d)}
          >
            {l}
          </button>
        ))}
      </div>
    </Pill>
  )
}

interface Props {
  schedule: Schedule
  timeZone: string
  /** Epoch ms from the caller, for the cron preview. */
  now: number
  today: string
  onChange: (s: Schedule) => void
}

export function SchedulePicker({ schedule: s, timeZone, now, today, onChange }: Props) {
  const preview = s.freq === 'custom' ? cronPreview(s.cron, timeZone, now) : null
  return (
    <div className="rt-schedule" data-testid="schedule-picker">
      <div className="rt-sched-row">
        <SearchSelect
          className="rt-select"
          data-testid="schedule-freq"
          aria-label="Frequency"
          value={s.freq}
          onChange={(v) => onChange(scheduleForFreq(v as Freq, s, today))}
        >
          {FREQS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </SearchSelect>
        {s.freq === 'once' && (
          <>
            <span className="rt-word">on</span>
            <input
              className="rt-select"
              type="date"
              data-testid="schedule-date"
              aria-label="Date"
              value={s.date}
              onChange={(e) => e.target.value && onChange({ ...s, date: e.target.value })}
            />
          </>
        )}
        {(s.freq === 'daily' || s.freq === 'hourly') && (
          <>
            <span className="rt-word">on</span>
            <DaysPicker days={s.days} onChange={(days) => onChange({ ...s, days })} />
          </>
        )}
        {s.freq === 'weekly' && (
          <>
            <span className="rt-word">on</span>
            <SearchSelect
              className="rt-select"
              data-testid="schedule-weekday"
              aria-label="Weekday"
              value={s.day}
              onChange={(v) => onChange({ ...s, day: +v })}
            >
              {WEEKDAYS.map((n, d) => (
                <option key={d} value={d}>
                  {n}
                </option>
              ))}
            </SearchSelect>
          </>
        )}
        {s.freq === 'monthly' && (
          <>
            <span className="rt-word">on</span>
            <SearchSelect
              className="rt-select"
              data-testid="schedule-monthday"
              aria-label="Day of month"
              value={String(s.day)}
              onChange={(v) => onChange({ ...s, day: v === 'last' ? 'last' : +v })}
            >
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
              <option value="last">Last day</option>
            </SearchSelect>
          </>
        )}
        {s.freq === 'yearly' && (
          <>
            <span className="rt-word">on</span>
            <SearchSelect
              className="rt-select"
              data-testid="schedule-month"
              aria-label="Month"
              value={s.month}
              onChange={(v) => {
                const month = +v
                const max = new Date(Date.UTC(2024, month, 0)).getUTCDate()
                onChange({ ...s, month, day: Math.min(s.day, max) })
              }}
            >
              {MONTHS.map((n, i) => (
                <option key={n} value={i + 1}>
                  {n}
                </option>
              ))}
            </SearchSelect>
            <SearchSelect
              className="rt-select"
              data-testid="schedule-yearday"
              aria-label="Day"
              value={s.day}
              onChange={(v) => onChange({ ...s, day: +v })}
            >
              {Array.from({ length: new Date(Date.UTC(2024, s.month, 0)).getUTCDate() }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </SearchSelect>
          </>
        )}
        {s.freq === 'hourly' && (
          <>
            <span className="rt-word">at minute</span>
            <SearchSelect
              className="rt-select"
              data-testid="schedule-minute"
              aria-label="Minute"
              value={s.minute}
              onChange={(v) => onChange({ ...s, minute: +v })}
            >
              {Array.from({ length: 60 }, (_, i) => i).map((m) => (
                <option key={m} value={m}>{`:${String(m).padStart(2, '0')}`}</option>
              ))}
            </SearchSelect>
          </>
        )}
        {s.freq !== 'hourly' && s.freq !== 'custom' && (
          <>
            <span className="rt-word">at</span>
            <TimePicker time={s.time} onChange={(time) => onChange({ ...s, time })} />
          </>
        )}
        {s.freq !== 'custom' && (
          <span className="rt-tz" data-testid="schedule-tz">
            {timeZone}
          </span>
        )}
      </div>
      {s.freq === 'custom' && (
        <div className="rt-cron">
          <input
            className="rt-input mono"
            data-testid="schedule-cron"
            aria-label="Cron expression"
            spellCheck={false}
            value={s.cron}
            placeholder="0 9 * * 1-5"
            onChange={(e) => onChange({ ...s, cron: e.target.value })}
          />
          <div className="rt-hint">Minute, hour, day of month, month, day of week. Times are in {timeZone}.</div>
          {preview === null ? (
            <div className="rt-hint rt-bad" data-testid="cron-invalid">
              Invalid cron expression
            </div>
          ) : (
            <ul className="rt-preview" data-testid="cron-preview">
              {preview.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
