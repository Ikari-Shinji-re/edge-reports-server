import startOfMonth from 'date-fns/startOfMonth'
import sub from 'date-fns/sub'
import nano from 'nano'

import { config } from './config'
import { getAnalytic } from './dbutils'
import { initDbs } from './initDbs'
import { asApps } from './types'
import { datelog, snooze } from './util'

const CACHE_UPDATE_LOOKBACK_MONTHS = config.cacheLookbackMonths ?? 3

const BULK_WRITE_SIZE = 50
const UPDATE_FREQUENCY_MS = 1000 * 60 * 30

const nanoDb = nano(config.couchDbFullpath)

const TIME_PERIODS = ['hour', 'day', 'month']

export async function cacheEngine(): Promise<void> {
  datelog('Starting Cache Engine')
  console.time('cacheEngine')

  await initDbs()

  const reportsApps = nanoDb.use('reports_apps')
  const reportsTransactions = nanoDb.use('reports_transactions')
  const reportsHour = nanoDb.use('reports_hour')
  const reportsDay = nanoDb.use('reports_day')
  const reportsMonth = nanoDb.use('reports_month')

  while (true) {
    let start
    const end = new Date(Date.now()).getTime() / 1000

    try {
      await reportsMonth.get('initialized:initialized')
      const monthStart = startOfMonth(new Date(Date.now()))
      start =
        sub(monthStart, { months: CACHE_UPDATE_LOOKBACK_MONTHS }).getTime() /
        1000
    } catch (e) {
      start = new Date(2017, 1, 20).getTime() / 1000
    }

    const query = {
      selector: {
        appId: { $exists: true }
      },
      limit: 1000000
    }
    const rawApps = await reportsApps.find(query)
    const apps = asApps(rawApps.docs)
    for (const app of apps) {
      if (config.soloAppIds != null && !config.soloAppIds.includes(app.appId)) {
        continue
      }
      const partnerIds = Object.keys(app.partnerIds)

      for (const partnerId of partnerIds) {
        if (
          config.soloPartnerIds != null &&
          !config.soloPartnerIds.includes(partnerId)
        ) {
          continue
        }
        for (const timePeriod of TIME_PERIODS) {
          const result = await getAnalytic(
            start,
            end,
            app.appId,
            partnerId,
            timePeriod,
            reportsTransactions
          )
          // Create cache docs
          if (result != null) {
            const cacheResult = result[timePeriod].map(bucket => {
              return {
                _id: `${app.appId}_${partnerId}:${bucket.isoDate}`,
                timestamp: bucket.start,
                usdValue: bucket.usdValue,
                numTxs: bucket.numTxs,
                currencyCodes: bucket.currencyCodes,
                currencyPairs: bucket.currencyPairs
              }
            })
            try {
              let database
              if (timePeriod === 'hour') database = reportsHour
              else if (timePeriod === 'day') database = reportsDay
              else {
                database = reportsMonth
              }
              // Fetch existing _revs of cache
              if (start !== new Date(2017, 1, 20).getTime() / 1000) {
                const documentIds = cacheResult.map(cache => {
                  return cache._id
                })
                const _revs = await database.fetchRevs({ keys: documentIds })
                for (let i = 0; i < _revs.rows.length; i++) {
                  if (
                    _revs.rows[i].error == null &&
                    _revs.rows[i].value.deleted !== true
                  ) {
                    cacheResult[i]._rev = _revs.rows[i].value.rev
                  }
                }
              }

              datelog(
                `Update cache db ${timePeriod} cache for ${app.appId}_${partnerId}. length = ${cacheResult.length}`
              )

              for (
                let start = 0;
                start < cacheResult.length;
                start += BULK_WRITE_SIZE
              ) {
                const end =
                  start + BULK_WRITE_SIZE > cacheResult.length
                    ? cacheResult.length
                    : start + BULK_WRITE_SIZE
                // datelog(`Bulk writing docs ${start} to ${end - 1}`)
                const docs = cacheResult.slice(start, end)
                datelog(
                  `Bulk writing docs ${start} to ${end} of ${cacheResult.length.toString()}`
                )
                await database.bulk({ docs })
              }

              datelog(
                `Finished updating ${timePeriod} cache for ${app.appId}_${partnerId}`
              )
            } catch (e) {
              datelog('Error doing bulk cache update', e)
              throw e
            }
          }
        }
      }
    }
    try {
      await reportsMonth.get('initialized:initialized')
      datelog('Cache Update Complete.')
    } catch {
      try {
        await reportsMonth
          .insert({ _id: 'initialized:initialized' })
          .then(() => {
            datelog('Cache Initialized.')
          })
      } catch {
        datelog('Failed to Create Initialized Marker.')
      }
    }
    console.timeEnd('cacheEngine')
    await snooze(UPDATE_FREQUENCY_MS)
  }
}
