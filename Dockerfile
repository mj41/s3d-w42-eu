# syntax=docker/dockerfile:1

FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
COPY main.go ./
COPY web ./web
COPY data ./data
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/s3d-w42-eu .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/s3d-w42-eu /s3d-w42-eu
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/s3d-w42-eu", "-listen", ":8080"]
