export type LocationKind = 'resort' | 'town' | 'pass' | 'custom'

export interface SnowLocation {
  id: string
  name: string
  kind: LocationKind
  lat: number
  lon: number
  /** Elevations in feet. Towns and passes have base === summit. */
  baseFt: number
  summitFt: number
  region: Region
}

export type Region =
  | 'Northern Mtns'
  | 'Central Mtns'
  | 'Southern Mtns'
  | 'Front Range'
  | 'Western Slope'
  | 'Plains'

const resort = (id: string, name: string, lat: number, lon: number, baseFt: number, summitFt: number, region: Region): SnowLocation =>
  ({ id, name, kind: 'resort', lat, lon, baseFt, summitFt, region })
const town = (id: string, name: string, lat: number, lon: number, ft: number, region: Region): SnowLocation =>
  ({ id, name, kind: 'town', lat, lon, baseFt: ft, summitFt: ft, region })
const pass = (id: string, name: string, lat: number, lon: number, ft: number, region: Region): SnowLocation =>
  ({ id, name, kind: 'pass', lat, lon, baseFt: ft, summitFt: ft, region })

export const LOCATIONS: SnowLocation[] = [
  resort('abasin', 'Arapahoe Basin', 39.642, -105.871, 10520, 13050, 'Central Mtns'),
  resort('aspen-mtn', 'Aspen Mountain', 39.186, -106.818, 7945, 11212, 'Central Mtns'),
  resort('aspen-highlands', 'Aspen Highlands', 39.182, -106.855, 8040, 12392, 'Central Mtns'),
  resort('beaver-creek', 'Beaver Creek', 39.604, -106.517, 8100, 11440, 'Central Mtns'),
  resort('breckenridge', 'Breckenridge', 39.480, -106.067, 9600, 12998, 'Central Mtns'),
  resort('buttermilk', 'Buttermilk', 39.205, -106.861, 7870, 9900, 'Central Mtns'),
  resort('copper', 'Copper Mountain', 39.502, -106.151, 9712, 12441, 'Central Mtns'),
  resort('crested-butte', 'Crested Butte', 38.899, -106.965, 9375, 12162, 'Central Mtns'),
  resort('echo', 'Echo Mountain', 39.685, -105.519, 10050, 10650, 'Front Range'),
  resort('eldora', 'Eldora', 39.937, -105.583, 9200, 10800, 'Front Range'),
  resort('granby-ranch', 'Granby Ranch', 40.044, -105.906, 8202, 9202, 'Northern Mtns'),
  resort('keystone', 'Keystone', 39.605, -105.954, 9280, 12408, 'Central Mtns'),
  resort('loveland', 'Loveland', 39.680, -105.898, 10800, 13010, 'Central Mtns'),
  resort('monarch', 'Monarch', 38.512, -106.332, 10790, 11952, 'Central Mtns'),
  resort('powderhorn', 'Powderhorn', 39.069, -108.150, 8200, 9850, 'Western Slope'),
  resort('purgatory', 'Purgatory', 37.630, -107.814, 8793, 10822, 'Southern Mtns'),
  resort('silverton', 'Silverton Mountain', 37.885, -107.666, 10400, 13487, 'Southern Mtns'),
  resort('ski-cooper', 'Ski Cooper', 39.361, -106.301, 10500, 11700, 'Central Mtns'),
  resort('snowmass', 'Snowmass', 39.209, -106.950, 8104, 12510, 'Central Mtns'),
  resort('steamboat', 'Steamboat', 40.457, -106.805, 6900, 10568, 'Northern Mtns'),
  resort('sunlight', 'Sunlight', 39.400, -107.338, 7885, 9895, 'Central Mtns'),
  resort('telluride', 'Telluride', 37.937, -107.847, 8725, 13150, 'Southern Mtns'),
  resort('vail', 'Vail', 39.606, -106.355, 8120, 11570, 'Central Mtns'),
  resort('winter-park', 'Winter Park', 39.887, -105.763, 9000, 12060, 'Northern Mtns'),
  resort('wolf-creek', 'Wolf Creek', 37.472, -106.793, 10300, 11904, 'Southern Mtns'),

  pass('berthoud-pass', 'Berthoud Pass', 39.798, -105.777, 11307, 'Front Range'),
  pass('cameron-pass', 'Cameron Pass', 40.520, -105.892, 10276, 'Northern Mtns'),
  pass('loveland-pass', 'Loveland Pass', 39.663, -105.879, 11990, 'Central Mtns'),
  pass('rabbit-ears', 'Rabbit Ears Pass', 40.384, -106.611, 9426, 'Northern Mtns'),
  pass('red-mtn-pass', 'Red Mountain Pass', 37.898, -107.712, 11018, 'Southern Mtns'),
  pass('vail-pass', 'Vail Pass', 39.531, -106.217, 10666, 'Central Mtns'),
  pass('wolf-creek-pass', 'Wolf Creek Pass', 37.483, -106.802, 10857, 'Southern Mtns'),

  town('denver', 'Denver', 39.7392, -104.9903, 5280, 'Plains'),
  town('boulder', 'Boulder', 40.0150, -105.2705, 5430, 'Front Range'),
  town('fort-collins', 'Fort Collins', 40.5853, -105.0844, 5003, 'Front Range'),
  town('colorado-springs', 'Colorado Springs', 38.8339, -104.8214, 6035, 'Front Range'),
  town('golden', 'Golden', 39.7555, -105.2211, 5675, 'Front Range'),
  town('evergreen', 'Evergreen', 39.6333, -105.3172, 7220, 'Front Range'),
  town('castle-rock', 'Castle Rock', 39.3722, -104.8561, 6224, 'Front Range'),
  town('littleton', 'Littleton', 39.6133, -105.0166, 5351, 'Front Range'),
  town('monument', 'Monument', 39.0917, -104.8728, 6975, 'Front Range'),
  town('estes-park', 'Estes Park', 40.3772, -105.5217, 7522, 'Front Range'),
  town('nederland', 'Nederland', 39.9614, -105.5108, 8228, 'Front Range'),
  town('pueblo', 'Pueblo', 38.2544, -104.6091, 4692, 'Plains'),
  town('grand-junction', 'Grand Junction', 39.0639, -108.5506, 4583, 'Western Slope'),
  town('durango', 'Durango', 37.2753, -107.8801, 6512, 'Southern Mtns'),
  town('pagosa-springs', 'Pagosa Springs', 37.2694, -107.0098, 7126, 'Southern Mtns'),
  town('gunnison', 'Gunnison', 38.5458, -106.9253, 7703, 'Central Mtns'),
  town('leadville', 'Leadville', 39.2508, -106.2925, 10152, 'Central Mtns'),
  town('frisco', 'Frisco', 39.5744, -106.0975, 9075, 'Central Mtns'),
  town('steamboat-springs', 'Steamboat Springs', 40.4850, -106.8317, 6732, 'Northern Mtns'),
]

export const LOCATIONS_BY_ID = new Map(LOCATIONS.map(l => [l.id, l]))

export const FT_PER_M = 3.28084
