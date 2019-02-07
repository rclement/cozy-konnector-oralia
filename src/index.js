const {
  BaseKonnector,
  normalizeFilename,
  requestFactory,
  signin,
  scrape,
  saveBills,
  log
} = require('cozy-konnector-libs')

const moment = require('moment')

const request = requestFactory({
  debug: false,
  cheerio: true,
  json: false,
  jar: true
})

const vendor = 'oralia'
const bankIdentifiers = ['oralia', 'faure']
const currency = 'EUR'
const baseUrl = 'https://www.myoralia.fr'
const loginUrl = `${baseUrl}/index.php`
const extranetBaseUrl = `${baseUrl}/extranet`
const selectionAccountUrl = `${extranetBaseUrl}/selection_account.php`
const ajaxLoadUrl = `${extranetBaseUrl}/include/ajax_load.php`

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching the list of accounts')
  const $ = await request(selectionAccountUrl)

  log('info', 'Parsing list of documents')
  const documents = await parseDocuments($)

  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields, {
    identifiers: bankIdentifiers
  })
}

// this shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
function authenticate(username, password) {
  return signin({
    url: loginUrl,
    formSelector: '#connexion',
    formData: {
      email: username,
      password: password,
      action: 'C',
      webphone: '0'
    },
    validate: (statusCode, $) => {
      if ($('script').length === 1) {
        return true
      } else {
        return false
      }
    }
  })
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
async function parseDocuments($) {
  // NOTE: seems like some kind of dirty csrf-token used as a query arg `&tmp=...` for `ajaxLoadUrl`,
  //       but it does not seem to be validated so stay disabled for now
  // let queryTmp = $('script')
  //   .get()[0]
  //   .children[0].data.match(/tmp=[^"]*/g)
  // if (queryTmp && queryTmp.length > 0) {
  //   queryTmp = queryTmp[0]
  // }

  const accounts = scrape(
    $,
    {
      name: {
        sel: '.details h3',
        parse: name =>
          name
            .replace(/ /g, '_')
            .toLowerCase()
            .trim()
      },
      url: {
        attr: 'onclick',
        parse: parseAjaxLoadUrl
      }
    },
    '.account-item'
  )

  let documents = []
  for (const account of accounts) {
    const $urlHash = await request(account.url, { method: 'POST' })
    const $dashboard = await request(`${extranetBaseUrl}/${$urlHash.text()}`)

    const dashboardLinks = scrape(
      $dashboard,
      {
        url: {
          attr: 'href',
          parse: url => `${extranetBaseUrl}/${url}`
        },
        isDocuments: {
          fn: $node => $node.hasClass('**MESDOCUMENTS**')
        }
      },
      'a.nav-link'
    )

    for (const link of dashboardLinks) {
      if (link.isDocuments) {
        const $docs = await request(link.url)
        let docs = scrape(
          $docs,
          {
            name: {
              sel: 'b',
              parse: parseDocumentName
            },
            date: {
              sel: 'small',
              parse: parseDocumentDate
            },
            url: {
              sel: 'a',
              attr: 'href',
              parse: url => `${extranetBaseUrl}/${url}`
            }
          },
          '#cREPMAIN ul li'
        )

        documents.push(
          ...docs.map(d => {
            const date = d.date.toDate()
            const dateStr = d.date.format('YYYY-MM-DD')
            const filename = normalizeFilename(
              `${dateStr}_${vendor}_${account.name}_${d.name}`
            )

            return {
              vendor: vendor,
              date: date,
              amount: 0,
              currency: currency,
              fileurl: d.url,
              filename: filename,
              metadata: {
                importDate: new Date(),
                version: 1
              }
            }
          })
        )
      }
    }

    return documents
  }
}

function parseAjaxLoadUrl(ajaxLoad) {
  const query = ajaxLoad.replace(/ajaxload\('/g, '').replace(/'\)/g, '')
  return `${ajaxLoadUrl}?${query}`
}

function parseDocumentName(name) {
  return name
    .replace(/ /g, '_')
    .toLowerCase()
    .trim()
}

function parseDocumentDate(date) {
  const dateFormat = 'YYYY-MM-DD'
  return moment.utc(
    date
      .slice('créé le '.length)
      .slice(0, dateFormat.length)
      .trim(),
    dateFormat
  )
}
