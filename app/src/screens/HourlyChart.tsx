import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { cumulative, type BlendedForecast } from '../forecast/blend'

const HOURS = 72
const HEIGHT = 200

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

const hourFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone: 'America/Denver' })
const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/Denver' })

/** "6a", "12p"; midnight shows the weekday instead so day boundaries are obvious. */
export function tickLabel(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  const h = hourFmt.format(d) // e.g. "6 AM"
  if (h === '12 AM') return dayFmt.format(d)
  return h.replace(' AM', 'a').replace(' PM', 'p')
}

/** Tick positions every 6 hours on local (Denver) clock hours: 12a, 6a, 12p, 6p. */
export function sixHourTicks(times: number[]): number[] {
  return times.filter(t => Number(hourFmt.format(new Date(t * 1000)).split(' ')[0]) % 6 === 0)
}

function axisBase() {
  return { stroke: css('--text-muted'), grid: { stroke: css('--grid'), width: 1 }, ticks: { show: false }, font: '11px system-ui' }
}

const xAxis = () => ({
  ...axisBase(),
  splits: (u: uPlot) => sixHourTicks(u.data[0] as number[]),
  values: (_u: uPlot, splits: number[]) => splits.map(tickLabel),
})

function usePlot(build: (width: number) => { opts: uPlot.Options; data: uPlot.AlignedData } | null, deps: unknown[]) {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = el.current
    if (!node) return
    const built = build(node.clientWidth)
    if (!built) return
    const plot = new uPlot(built.opts, built.data, node)
    const ro = new ResizeObserver(() => plot.setSize({ width: node.clientWidth, height: HEIGHT }))
    ro.observe(node)
    return () => { ro.disconnect(); plot.destroy() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return el
}

const window72 = (f: BlendedForecast) => [f.nowIndex, Math.min(f.times.length, f.nowIndex + HOURS)] as const

/** Next 72 hours: hourly snowfall rate (in/hr) bars with the running total line. */
export function HourlyChart({ forecast }: { forecast: BlendedForecast }) {
  const el = usePlot(width => {
    const [a, b] = window72(forecast)
    const rate = forecast.hourlySnowIn.slice(a, b)
    return {
      data: [forecast.times.slice(a, b), rate, cumulative(rate)],
      opts: {
        width,
        height: HEIGHT,
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
        scales: {
          x: { time: false },
          rate: { range: (_u, _min, max) => [0, Math.max(0.2, max * 1.15)] },
          total: { range: (_u, _min, max) => [0, Math.max(1, max * 1.1)] },
        },
        axes: [
          xAxis(),
          { ...axisBase(), scale: 'rate', label: 'in/hr', labelSize: 14, labelFont: '11px system-ui', size: 40, values: (_u, vals) => vals.map(v => String(+v.toFixed(2))) },
          { ...axisBase(), scale: 'total', side: 1, grid: { show: false }, label: 'total in', labelSize: 14, labelFont: '11px system-ui', size: 40, values: (_u, vals) => vals.map(v => `${v}"`) },
        ],
        series: [
          {},
          { label: 'in/hr', scale: 'rate', fill: css('--snow'), stroke: css('--snow'), paths: uPlot.paths.bars!({ size: [0.8, 12] }), points: { show: false } },
          { label: 'Total', scale: 'total', stroke: css('--accent'), width: 2, points: { show: false } },
        ],
      },
    }
  }, [forecast])
  return <div ref={el} className="chart" />
}

/** Next 72 hours: temperature with sustained wind and gusts, a secondary view. */
export function WeatherChart({ forecast }: { forecast: BlendedForecast }) {
  const el = usePlot(width => {
    const [a, b] = window72(forecast)
    if (!forecast.hourlyTempF.slice(a, b).some(v => v != null)) return null
    return {
      data: [forecast.times.slice(a, b), forecast.hourlyTempF.slice(a, b), forecast.hourlyWindMph.slice(a, b), forecast.hourlyGustMph.slice(a, b)],
      opts: {
        width,
        height: HEIGHT,
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
        scales: { x: { time: false }, temp: { auto: true }, wind: { range: (_u, _min, max) => [0, Math.max(20, max * 1.1)] } },
        axes: [
          xAxis(),
          { ...axisBase(), scale: 'temp', size: 36, values: (_u, vals) => vals.map(v => `${v}°`) },
          { ...axisBase(), scale: 'wind', side: 1, grid: { show: false }, size: 36, values: (_u, vals) => vals.map(v => `${v}`) },
        ],
        series: [
          {},
          { label: 'Temp °F', scale: 'temp', stroke: css('--warm'), width: 2, points: { show: false } },
          { label: 'Wind mph', scale: 'wind', stroke: css('--wind'), width: 1.5, points: { show: false } },
          { label: 'Gust mph', scale: 'wind', stroke: css('--wind'), width: 1, dash: [4, 4], points: { show: false } },
        ],
      },
    }
  }, [forecast])
  return <div ref={el} className="chart" />
}
