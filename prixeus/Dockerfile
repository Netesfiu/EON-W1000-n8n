FROM golang AS builder

WORKDIR /src

COPY w1000.go go.mod go.sum /src/.

RUN CGO_ENABLED=0 go build

FROM scratch

COPY --from=builder /tmp /tmp
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=builder /src/w1000-go /w1000-go

CMD ["/w1000-go"]