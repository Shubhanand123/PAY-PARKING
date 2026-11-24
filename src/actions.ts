import * as engine from './engine'
import { apiEnabled, callParking } from './parking-api'

function action<A extends unknown[], R>(name: string, fn: (db: engine.DB, staff: engine.Staff, ...args: A) => R) {
  return async (staffId: string, ...args: A): Promise<R> => {
    if (apiEnabled) return (await callParking<R>(name, args)).result
    const db = engine.load()
    const result = engine.runAction(db, staffId, fn, ...args)
    engine.save(db)
    window.dispatchEvent(new Event('parking-change'))
    return result
  }
}

export const createEntry = action('createEntry', engine.createEntry)
export const markPrinted = action('markPrinted', engine.markPrinted)
export const logLookup = action('logLookup', engine.logLookup)
export const takeCash = action('takeCash', engine.takeCash)
export const recordExit = action('recordExit', engine.recordExit)
export const cancelTicket = action('cancelTicket', engine.cancelTicket)
export const publishTariff = action('publishTariff', engine.publishTariff)
export const saveSettings = action('saveSettings', engine.saveSettings)
export const addFreeVehicle = action('addFreeVehicle', engine.addFreeVehicle)
export const removeFreeVehicle = action('removeFreeVehicle', engine.removeFreeVehicle)
