/** What a connector hands back, independent of which API it came from. */
export type VehicleIdentity = {
  teslaId: string;
  vin: string | null;
  displayName: string;
  model: string | null;
  state: string | null;
};

export type Reading = {
  at: string;
  odometerMiles: number | null;
  latitude: number | null;
  longitude: number | null;
  shiftState: string | null;
  speedMph: number | null;
  state: string | null;
  chargingState: string | null;
  batteryLevel: number | null;
  /** True when the API served a stored snapshot rather than a live read. */
  cached: boolean;
};

export type ReadResult =
  | { ok: true; reading: Reading; creditsSpent: number }
  | { ok: false; reason: 'asleep' | 'unauthorized' | 'rate_limited' | 'error' | 'budget'; detail: string; creditsSpent: number };

export type Connector = {
  readonly name: string;
  /** Vehicles on the account. */
  listVehicles(): Promise<VehicleIdentity[]>;
  /** One reading for one vehicle. Must never wake a sleeping car. */
  read(vehicle: VehicleIdentity): Promise<ReadResult>;
};
