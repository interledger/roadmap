import 'dotenv/config'
import { linear } from './client.js'

const LIST_CUSTOM_VIEWS_QUERY = `
  query ListCustomViews {
    customViews {
      nodes {
        id
        name
      }
    }
  }
`

async function main() {
  try {
    const result = await linear.client.request<{ customViews: { nodes: { id: string; name: string }[] } }>(LIST_CUSTOM_VIEWS_QUERY)
    result.customViews.nodes.forEach(v => console.log(`${v.id}  ${v.name}`))
  } catch (err) {
    console.error('Error:', err)
    process.exit(1)
  }
}

main()
