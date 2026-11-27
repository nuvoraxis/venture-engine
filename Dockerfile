FROM node:20-alpine
WORKDIR /app
COPY products/ ./products/
ENTRYPOINT ["node", "products/aegisgate/src/mcp_server.mjs"]
