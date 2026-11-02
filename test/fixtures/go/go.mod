// A hand-written go.mod covering the grammar test/go.test.js checks.
module example.com/app

go 1.22

toolchain go1.22.4

godebug default=go1.21

require github.com/single/line v1.0.0

require (
	github.com/block/one v1.1.0
	"github.com/quoted/path" v0.3.0
	github.com/twice/required v1.0.0 // indirect
	github.com/renamed/old v1.0.0
	github.com/bumped/same v1.0.0
	github.com/pinned/only v1.0.0
	github.com/local/dot v0.1.0
	github.com/commented/direct v2.0.0 // pinned for a reason
)

exclude github.com/block/one v1.0.9

exclude (
	github.com/single/line v0.9.0
	github.com/block/one v1.0.8
)

retract (
	v0.1.0 // published by mistake
	[v0.2.0, v0.2.5] // broken release range
)

tool (
	golang.org/x/tools/cmd/stringer
)

frobnicate (
	github.com/should/not-appear v9.9.9
)

require (
	github.com/twice/required v1.2.0
	github.com/indirect/plain v0.5.0 // indirect
	github.com/indirect/renamed v0.6.0 // indirect
	github.com/local/dotdot v0.2.0 // indirect
)

replace github.com/renamed/old => github.com/renamed/new v1.5.0

replace (
	github.com/bumped/same => github.com/bumped/same v1.0.3
	github.com/pinned/only v1.0.0 => github.com/pinned/fork v1.0.1
	github.com/pinned/only => github.com/pinned/general v9.0.0
	github.com/local/dot => ./local/dot
	github.com/indirect/renamed => github.com/indirect/fork v0.6.1
	github.com/not/required => github.com/whatever v1.0.0
)

replace github.com/local/dotdot v0.2.0 => ../dotdot
