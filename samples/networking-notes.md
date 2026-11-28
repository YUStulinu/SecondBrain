# Computer Networks: lecture notes

(Written as sample material for the Second Brain demo.)

## The transport layer

The transport layer gives each application on a host its own conversation, identified by a port
number. Ports below 1024 are reserved for well-known services: HTTP uses port 80 and HTTPS uses
port 443.

## Opening a TCP connection

A TCP connection is opened with a three-way handshake: the client sends SYN, the server answers
with SYN-ACK, and the client confirms with ACK. Only after the third segment can either side send
data. Each side picks a random initial sequence number, which protects against old segments from
an earlier connection being accepted by mistake.

## Closing a connection

Closing takes four segments, because each direction is closed on its own with a FIN and its ACK.
The side that closes first waits in TIME_WAIT for twice the maximum segment lifetime, usually
60 seconds on Linux, so that late segments of the old connection die out.

## Flow control and congestion control

Flow control protects the receiver: the advertised window says how many bytes it can still buffer.
Congestion control protects the network. TCP starts with slow start, doubling the congestion window
every round trip, until it reaches the slow-start threshold or sees a loss. After a loss detected by
three duplicate ACKs, TCP Reno halves the congestion window; after a timeout it falls back to a
window of one segment.

## UDP

UDP sends independent datagrams with no handshake, no ordering and no retransmission. It suits DNS
queries, voice and video, and games, where a late packet is worth less than a lost one. QUIC, the
transport under HTTP/3, runs over UDP and rebuilds reliability and encryption on top of it.
