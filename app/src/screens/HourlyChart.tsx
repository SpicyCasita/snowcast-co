import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { BlendedForecast } from '../forecast/blend'

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** Next 72 hours: hourly snow bars with the blended temperature line. */
export function HourlyChart({ forecast }: { forecast: BlendedForecast }) {
  const el = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = el.current
    if (!node) return
    const a = forecast.nowIndex
    const b = Math.min(forecast.times.length, a + 72)
    const data: uPlot.AlignedData = [
      forecast.times.slice(a, b),
      forecast.hourlySnowIn.slice(a, b),
      forecast.hourlyTempF.slice(a, b),
    ]
    const axis = { stroke: css('--text-muted'), grid: { stroke: css('--grid'), width: 1 }, ticks: { show: false }, font: '11px system-ui' }
    const plot = new uPlot({
      width: node.clientWidth,
      height: 200,
      tzDate: ts => uPlot.tzDate(new Date(ts * 1000), 'America/Denver'),
      legend: { show: false },
      cursor: { drag: { x: false, y: false } },
      scales: { snow: { range: (_u, _min, max) => [0, Math.max(0.5, max * 1.15)] }, temp: { auto: true } },
      axes: [
        { ...axis },
        { ...axis, scale: 'snow', values: (_u, vals) => vals.map(v => `${v}"`), size: 40 },
        { ...axis, scale: 'temp', side: 1, grid: { show: false }, values: (_u, vals) => vals.map(v => `${v}°`), size: 36 },
      ],
      series: [
        {},
        { label: 'Snow', scale: 'snow', fill: css('--snow'), stroke: css('--snow'), paths: uPlot.paths.bars!({ size: [0.8, 12] }), points: { show: false } },
        { label: 'Temp', scale: 'temp', stroke: css('--warm'), width: 1.5, points: { show: false } },
      ],
    }, data, node)
    const ro = new ResizeObserver(() => plot.setSize({ width: node.clientWidth, height: 200 }))
    ro.observe(node)
    return () => { ro.disconnect(); plot.destroy() }
  }, [forecast])

  return <div ref={el} className="chart" />
}
