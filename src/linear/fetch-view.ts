import "dotenv/config";
import { linear } from "./client.js";

const LIST_CUSTOM_VIEWS_QUERY = `
  query ListCustomViews {
    customViews {
      nodes {
        id
        name
        description
        icon
        color
        modelName
        filters
        filterData
        owner {
          id
          name
        }
        team {
          id
          name
          key
        }
      }
    }
  }
`;

const GET_CUSTOM_VIEW_QUERY = `
  query GetCustomView($id: String!, $after: String) {
    customView(id: $id) {
      id
      name
      description
      icon
      color
      modelName
      filters
      filterData
      owner { id name }
      team { id name key }
      projects(first: 250, after: $after) {
        nodes {
          id
          name
          sortOrder
          description
          state
          priority
          priorityLabel
          startDate
          targetDate
          progress
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

async function main() {
  const id = process.argv[2];
  try {
    if (id) {
      console.log(`Fetching custom view: ${id}\n`);
      const result = await linear.client.request(GET_CUSTOM_VIEW_QUERY, {
        id,
        after: null,
      });
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("No id provided — listing all custom views:\n");
      const result = await linear.client.request(LIST_CUSTOM_VIEWS_QUERY);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

main();
