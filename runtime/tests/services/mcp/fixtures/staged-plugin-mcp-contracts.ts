// Exact public MCP declarations copied from the nine staged integration manifests.
export default [
  {
    "name": "gmail",
    "mcpServers": {
      "gmail": {
        "transport": "http",
        "endpoint": "https://gmailmcp.googleapis.com/mcp/v1",
        "enabled": false,
        "oauth": {
          "clientId": "${user_config.CLIENT_ID}",
          "scopes": [
            "https://www.googleapis.com/auth/gmail.readonly"
          ],
          "authServerMetadataUrl": "https://accounts.google.com/.well-known/openid-configuration"
        },
        "enabled_tools": [
          "get_message",
          "get_thread",
          "list_labels",
          "search_threads"
        ],
        "default_tools_approval_mode": "on-request"
      }
    },
    "userConfig": {
      "CLIENT_ID": {
        "type": "string",
        "title": "Google OAuth client ID",
        "description": "The operator's registered Google OAuth client ID for AgenC; never use another application's client identity.",
        "required": true
      }
    }
  },
  {
    "name": "figma",
    "mcpServers": {
      "figma": {
        "transport": "http",
        "endpoint": "https://mcp.figma.com/mcp",
        "enabled": false,
        "oauth": {},
        "enabled_tools": [
          "whoami",
          "get_design_context",
          "get_screenshot",
          "get_metadata",
          "get_variable_defs",
          "get_code_connect_map"
        ],
        "default_tools_approval_mode": "on-request"
      }
    }
  },
  {
    "name": "github",
    "mcpServers": {
      "github": {
        "transport": "http",
        "endpoint": "https://api.githubcopilot.com/mcp/readonly",
        "enabled": false,
        "headers": {
          "Authorization": "Bearer ${user_config.TOKEN}"
        },
        "enabled_tools": [
          "get_me",
          "search_repositories",
          "get_file_contents",
          "list_branches",
          "list_commits",
          "list_issues",
          "issue_read",
          "list_pull_requests",
          "pull_request_read",
          "search_code"
        ],
        "default_tools_approval_mode": "on-request"
      }
    },
    "userConfig": {
      "TOKEN": {
        "type": "string",
        "title": "GitHub access token",
        "description": "A user-provided GitHub token with read permissions for the selected repositories. Stored through AgenC's sensitive configuration flow.",
        "required": true,
        "sensitive": true
      }
    }
  },
  {
    "name": "context7",
    "mcpServers": {
      "context7": {
        "transport": "http",
        "endpoint": "https://mcp.context7.com/mcp",
        "enabled": false,
        "headers": {
          "Authorization": "Bearer ${user_config.API_KEY}"
        },
        "enabled_tools": [
          "resolve-library-id",
          "query-docs"
        ],
        "default_tools_approval_mode": "on-request"
      }
    },
    "userConfig": {
      "API_KEY": {
        "type": "string",
        "title": "Context7 API key",
        "description": "User-owned Context7 API key, entered through sensitive configuration.",
        "required": true,
        "sensitive": true
      }
    }
  },
  {
    "name": "linear",
    "mcpServers": {
      "linear": {
        "transport": "http",
        "endpoint": "https://mcp.linear.app/mcp/readonly",
        "enabled": false,
        "oauth": {
          "scopes": [
            "read"
          ]
        },
        "default_tools_approval_mode": "on-request"
      }
    }
  },
  {
    "name": "sentry",
    "mcpServers": {
      "sentry": {
        "transport": "http",
        "endpoint": "https://mcp.sentry.dev/mcp",
        "enabled": false,
        "oauth": {},
        "enabled_tools": [
          "find_organizations",
          "find_projects",
          "get_sentry_resource",
          "search_issues",
          "search_events"
        ],
        "default_tools_approval_mode": "on-request"
      }
    }
  },
  {
    "name": "supabase",
    "mcpServers": {
      "supabase": {
        "transport": "http",
        "endpoint": "https://mcp.supabase.com/mcp?project_ref=${user_config.PROJECT_REF}&read_only=true&features=database,docs",
        "enabled": false,
        "oauth": {},
        "enabled_tools": [
          "list_tables",
          "list_extensions",
          "list_migrations",
          "execute_sql",
          "search_docs"
        ],
        "default_tools_approval_mode": "on-request"
      }
    },
    "userConfig": {
      "PROJECT_REF": {
        "type": "string",
        "title": "Supabase project reference",
        "description": "The exact project reference, not a URL or query string. Select the intended development project before connecting.",
        "required": true
      }
    }
  },
  {
    "name": "vercel",
    "mcpServers": {
      "vercel": {
        "transport": "http",
        "endpoint": "https://mcp.vercel.com",
        "enabled": false,
        "oauth": {},
        "enabled_tools": [
          "search_vercel_documentation",
          "list_teams",
          "list_projects",
          "get_project",
          "list_deployments",
          "get_deployment",
          "get_deployment_build_logs",
          "get_runtime_logs"
        ],
        "default_tools_approval_mode": "on-request"
      }
    }
  },
  {
    "name": "playwright",
    "mcpServers": {
      "playwright": {
        "transport": "stdio",
        "command": "node",
        "args": [
          "${AGENC_PLUGIN_ROOT}/scripts/run-playwright.mjs"
        ],
        "enabled": false,
        "env": {
          "AGENC_PLAYWRIGHT_RUNTIME": "${user_config.RUNTIME_DIR}"
        },
        "enabled_tools": [
          "browser_navigate",
          "browser_navigate_back",
          "browser_snapshot",
          "browser_take_screenshot",
          "browser_console_messages",
          "browser_network_requests",
          "browser_tabs",
          "browser_wait_for",
          "browser_close"
        ],
        "default_tools_approval_mode": "on-request"
      }
    },
    "userConfig": {
      "RUNTIME_DIR": {
        "type": "string",
        "title": "Provisioned Playwright runtime directory",
        "description": "Absolute path outside the signed plugin containing node_modules from this package's exact reviewed lockfile. No automatic installation occurs.",
        "required": true
      }
    }
  }
];
