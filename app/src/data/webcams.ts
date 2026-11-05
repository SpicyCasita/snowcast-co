/**
 * Webcam pages for every resort, checked to load on 2026-11-04. Official resort pages where they exist;
 * Silverton and Echo don't run their own live cams, so they link a labelled third-party page instead.
 */
export interface Webcam {
  url: string
  /** Who runs the page, shown next to the link when it isn't the resort itself. */
  source?: string
}

const vailResorts = (host: string): Webcam => ({ url: `https://www.${host}/the-mountain/mountain-conditions/mountain-cams.aspx` })
const aspen = (mountain: string): Webcam => ({ url: `https://www.aspensnowmass.com/four-mountains/${mountain}/mountain-cams` })

export const WEBCAMS: Record<string, Webcam> = {
  abasin: { url: 'https://www.arapahoebasin.com/mountain-cams/' },
  'aspen-mtn': aspen('aspen-mountain'),
  'aspen-highlands': aspen('aspen-highlands'),
  'beaver-creek': vailResorts('beavercreek.com'),
  breckenridge: vailResorts('breckenridge.com'),
  buttermilk: aspen('buttermilk'),
  copper: { url: 'https://www.coppercolorado.com/the-mountain/webcams/' },
  'crested-butte': vailResorts('skicb.com'),
  echo: { url: 'https://www.onthesnow.com/colorado/echo-mountain/webcams', source: 'OnTheSnow' },
  eldora: { url: 'https://www.eldora.com/the-mountain/current-conditions/webcams/' },
  'granby-ranch': { url: 'https://granbyranch.com/live-web-cams/' },
  keystone: vailResorts('keystoneresort.com'),
  loveland: { url: 'https://skiloveland.com/webcams/' },
  monarch: { url: 'https://skimonarch.com/conditions/cams/' },
  powderhorn: { url: 'https://www.powderhorn.com/webcams/' },
  purgatory: { url: 'https://www.purgatory.ski/mountain/weather-conditions-webcams/webcams/' },
  silverton: { url: 'https://opensnow.com/location/silverton/cams', source: 'OpenSnow · town & pass cams' },
  'ski-cooper': { url: 'https://www.skicooper.com/weather-webcams/' },
  snowmass: aspen('snowmass'),
  steamboat: { url: 'https://www.steamboat.com/the-mountain/live-cams' },
  sunlight: { url: 'https://sunlightmtn.com/explore/mountain-status/' },
  telluride: { url: 'https://tellurideskiresort.com/webcams/' },
  vail: vailResorts('vail.com'),
  'winter-park': { url: 'https://www.winterparkresort.com/the-mountain/mountain-cams' },
  'wolf-creek': { url: 'https://wolfcreekski.com/webcams/' },
}
