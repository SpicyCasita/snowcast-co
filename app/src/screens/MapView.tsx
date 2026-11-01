import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { LOCATIONS } from '../data/locations'

const COLORADO_BOUNDS: [[number, number], [number, number]] = [[-109.06, 36.99], [-102.04, 41.0]]

export function MapView() {
  const el = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!el.current) return
    const map = new maplibregl.Map({
      container: el.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      bounds: COLORADO_BOUNDS,
      fitBoundsOptions: { padding: 16 },
      attributionControl: { compact: true },
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'top-right')

    for (const l of LOCATIONS) {
      const dot = document.createElement('a')
      dot.className = `map-pin pin-${l.kind}`
      dot.href = `#/loc/${l.id}`
      dot.title = l.name
      dot.textContent = l.kind === 'resort' ? '❄' : l.kind === 'pass' ? '▲' : '•'
      new maplibregl.Marker({ element: dot }).setLngLat([l.lon, l.lat]).addTo(map)
    }

    let popup: maplibregl.Popup | null = null
    map.on('click', e => {
      const { lat, lng } = e.lngLat
      popup?.remove()
      popup = new maplibregl.Popup({ closeButton: false })
        .setLngLat(e.lngLat)
        .setHTML(`<a class="popup-link" href="#/pt/${lat.toFixed(4)},${lng.toFixed(4)}">Snow forecast here →</a>`)
        .addTo(map)
    })
    return () => map.remove()
  }, [])

  return (
    <div className="map-screen">
      <div ref={el} className="map" />
      <div className="map-hint">Tap anywhere for a point forecast</div>
    </div>
  )
}
