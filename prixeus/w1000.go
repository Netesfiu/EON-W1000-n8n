package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/ioutil"
	"log"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-imap/client"
	"github.com/jhillyerd/enmime"
	"github.com/xuri/excelize/v2"
	"gopkg.in/yaml.v3"
)

/*
E.ON -> Home Assistant importer in Go.

Modes:
  - one-shot: --once path/to/file.xlsx
  - IMAP poll loop (default): IMAP env vars must be set.

Environment variables:
  IMAP_HOST, IMAP_PORT (default 993), IMAP_USER, IMAP_PASS
  HA_URL (https://your-ha:8123), HA_TOKEN
  HA_UPDATE_INPUT_NUMBERS (true/false, default true)
  IMAP_POLL_INTERVAL (seconds, default 60)
  LOG_LEVEL (INFO/DEBUG)
*/

const (
	// Entities / stat ids from your workflow
	entityImportStatID = "sensor.grid_energy_import"
	entityExportStatID = "sensor.grid_energy_export"
	inputNumberImport  = "input_number.grid_import_meter"
	inputNumberExport  = "input_number.grid_export_meter"
)

type Config struct {
	IMAP struct {
		Host string `yaml:"host"`
		Port int    `yaml:"port"`
		User string `yaml:"user"`
		Pass string `yaml:"pass"`
	} `yaml:"imap"`

	HomeAssistant struct {
		URL   string `yaml:"url"`
		Token string `yaml:"token"`
	} `yaml:"homeassistant"`

	PollIntervalSeconds int    `yaml:"poll_interval"`
	UpdateInputNumbers  bool   `yaml:"update_input_numbers"`
	LogLevel            string `yaml:"log_level"`
}

// LoadConfig loads config.yaml (or another file) and fills a Config struct.
func LoadConfig(path string) (Config, error) {
	var cfg Config

	data, err := ioutil.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("read config file: %w", err)
	}

	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("yaml parse error: %w", err)
	}

	applyDefaults(&cfg)

	return cfg, validateConfig(cfg)
}

// Defaults for optional fields
func applyDefaults(cfg *Config) {
	if cfg.IMAP.Port == 0 {
		cfg.IMAP.Port = 993
	}
	if cfg.PollIntervalSeconds == 0 {
		cfg.PollIntervalSeconds = 60
	}
	if cfg.LogLevel == "" {
		cfg.LogLevel = "INFO"
	}
}

// Validate required fields
func validateConfig(cfg Config) error {
	if cfg.IMAP.Host == "" {
		return errors.New("missing imap.host")
	}
	if cfg.IMAP.User == "" {
		return errors.New("missing imap.user")
	}
	if cfg.IMAP.Pass == "" {
		return errors.New("missing imap.pass")
	}
	if cfg.HomeAssistant.URL == "" {
		return errors.New("missing homeassistant.url")
	}
	if cfg.HomeAssistant.Token == "" {
		return errors.New("missing homeassistant.token")
	}
	return nil
}

// RowPiece is a small piece of data extracted from the sheet:
// Start time (hour resolution) + one of AP/AM/1_8_0/2_8_0
type RowPiece struct {
	Start time.Time
	AP    *float64
	AM    *float64
	M180  *float64 // 1_8_0
	M280  *float64 // 2_8_0
}

// AggregatedHour is per-hour aggregate before meter reconstruction
type AggregatedHour struct {
	Start time.Time
	AP    float64
	AM    float64
	M180  *float64
	M280  *float64
}

// CalculatedRow is final row like in n8n output
type CalculatedRow struct {
	Start time.Time
	AP    string
	AM    string
	M180  string // start180
	M280  string
}

func parsePossibleTime(value string) (time.Time, error) {
	t, err := time.ParseInLocation(
		time.DateTime,
		strings.ReplaceAll(value, ".", "-")+":00",
		time.Local,
	)
	if err == nil {
		// For unknown reason the HA statistics acts like it is in DST
		return t.Add(-1 * time.Hour), nil
	}

	return time.Time{}, errors.New("unrecognized time format")
}

// readEonExcelIntoPieces reads the xlsx and returns RowPieces (possibly many pieces per hour)
func readEonExcelIntoPieces(path string) ([]RowPiece, error) {
	f, err := excelize.OpenFile(path)
	if err != nil {
		return nil, fmt.Errorf("open excel: %w", err)
	}
	defer f.Close()

	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return nil, fmt.Errorf("no sheets in file")
	}
	sheet := sheets[0]

	rows, err := f.GetRows(sheet)
	if err != nil {
		return nil, fmt.Errorf("get rows: %w", err)
	}
	if len(rows) < 2 {
		return nil, fmt.Errorf("sheet has no data")
	}

	header := rows[0]

	// Find "Időbélyeg" column
	timeCol := -1
	valueCols := []int{} // will contain four "Érték" indexes

	for i, h := range header {
		name := strings.TrimSpace(h)
		if name == "Időbélyeg" {
			timeCol = i
		}
		if name == "Érték" {
			valueCols = append(valueCols, i)
		}
	}

	if timeCol < 0 {
		return nil, fmt.Errorf("no Időbélyeg column found")
	}
	if len(valueCols) != 4 {
		return nil, fmt.Errorf("expected 4 'Érték' columns, found %d", len(valueCols))
	}

	// valueCols[0]=AP, [1]=AM, [2]=M180, [3]=M280
	pieces := []RowPiece{}

	for r := 1; r < len(rows); r++ {
		row := rows[r]
		if timeCol >= len(row) {
			continue
		}

		rawTime := strings.TrimSpace(row[timeCol])
		if rawTime == "" {
			continue
		}

		t, err := parsePossibleTime(rawTime)
		if err != nil {
			// Skip rows with bad timestamps
			continue
		}
		t = t.Truncate(time.Hour)

		rp := RowPiece{Start: t}

		// Helper to convert "Érték" field to float
		parseValue := func(col int) *float64 {
			if col >= len(row) {
				return nil
			}
			v := strings.TrimSpace(row[col])
			if v == "" {
				return nil
			}
			f, err := strconv.ParseFloat(strings.ReplaceAll(v, ",", "."), 64)
			if err != nil {
				return nil
			}
			return &f
		}

		// Assign in fixed order
		rp.AP = parseValue(valueCols[0])
		rp.AM = parseValue(valueCols[1])
		rp.M180 = parseValue(valueCols[2])
		rp.M280 = parseValue(valueCols[3])

		// Append only if something is not nil
		if rp.AP != nil || rp.AM != nil || rp.M180 != nil || rp.M280 != nil {
			pieces = append(pieces, rp)
		}
	}

	if len(pieces) == 0 {
		return nil, fmt.Errorf("no valid data rows found")
	}

	return pieces, nil
}

// mergeRowsAndAggregate: combine pieces into AggregatedHour per hour
func mergeRowsAndAggregate(pieces []RowPiece) []AggregatedHour {
	m := map[int64]*AggregatedHour{} // unix hour timestamp -> aggregated
	for _, p := range pieces {
		k := p.Start.Unix()
		a, ok := m[k]
		if !ok {
			// copy start as time in local
			a = &AggregatedHour{Start: p.Start, AP: 0, AM: 0, M180: nil, M280: nil}
			m[k] = a
		}
		if p.AP != nil {
			a.AP += *p.AP
		}
		if p.AM != nil {
			a.AM += *p.AM
		}
		if p.M180 != nil {
			a.M180 = new(float64)
			*a.M180 = *p.M180
		}
		if p.M280 != nil {
			a.M280 = new(float64)
			*a.M280 = *p.M280
		}
	}
	// sort by time
	keys := make([]int64, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	out := make([]AggregatedHour, 0, len(keys))
	for _, k := range keys {
		out = append(out, *m[k])
	}
	return out
}

// calculateHourlyCumulative implements the same logic as n8n Code node
func calculateHourlyCumulative(hours []AggregatedHour) []CalculatedRow {
	var last180 *float64
	var last280 *float64
	out := make([]CalculatedRow, 0, len(hours))
	for _, h := range hours {
		if h.M180 != nil {
			x := *h.M180
			last180 = &x
		}
		if h.M280 != nil {
			x := *h.M280
			last280 = &x
		}
		if last180 == nil {
			zero := 0.0
			last180 = &zero
		}
		if last280 == nil {
			zero := 0.0
			last280 = &zero
		}
		start180 := *last180
		start280 := *last280
		end180 := start180 + h.AP
		end280 := start280 + h.AM
		// update last
		last180 = &end180
		last280 = &end280
		out = append(out, CalculatedRow{
			Start: h.Start,
			AP:    fmt.Sprintf("%.3f", h.AP),
			AM:    fmt.Sprintf("%.3f", h.AM),
			M180:  fmt.Sprintf("%.3f", start180),
			M280:  fmt.Sprintf("%.3f", start280),
		})
	}
	return out
}

// build stats list: {start: ISO, state: float, sum: float}
func buildStatsList(calculated []CalculatedRow, meterKey string) []map[string]interface{} {
	stats := make([]map[string]interface{}, 0, len(calculated))
	for _, r := range calculated {
		var state float64
		if meterKey == "1_8_0" {
			state, _ = strconv.ParseFloat(r.M180, 64)
		} else {
			state, _ = strconv.ParseFloat(r.M280, 64)
		}
		// Home Assistant expects ISO strings with timezone
		startISO := r.Start.Format(time.RFC3339)
		stats = append(stats, map[string]interface{}{
			"start": startISO,
			"state": state,
			"sum":   state,
		})
	}
	return stats
}

// callHomeAssistantService calls /api/services/{domain}/{service}
func callHomeAssistantService(cfg Config, domain, service string, body interface{}) error {
	if cfg.HomeAssistant.URL == "" || cfg.HomeAssistant.Token == "" {
		return errors.New("HA_URL and HA_TOKEN must be set")
	}
	url := strings.TrimRight(cfg.HomeAssistant.URL, "/") + "/api/services/" + domain + "/" + service
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.HomeAssistant.Token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := ioutil.ReadAll(resp.Body)
		return fmt.Errorf("HA service call failed: %d %s", resp.StatusCode, string(b))
	}
	return nil
}

func updateInputNumber(cfg Config, entityID string, value float64) error {
	if cfg.HomeAssistant.URL == "" || cfg.HomeAssistant.Token == "" {
		return errors.New("HA_URL and HA_TOKEN must be set")
	}
	url := strings.TrimRight(cfg.HomeAssistant.URL, "/") + "/api/states/" + entityID
	body := map[string]interface{}{
		"state": fmt.Sprintf("%.3f", value),
	}
	payload, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+cfg.HomeAssistant.Token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := ioutil.ReadAll(resp.Body)
		return fmt.Errorf("update entity failed: %d %s", resp.StatusCode, string(b))
	}
	return nil
}

// processFile: reads xlsx, computes calculated rows, optionally pushes to HA
func processFile(cfg Config, path string, pushToHA bool) ([]CalculatedRow, error) {
	log.Printf("[INFO] processing file %s", path)
	pieces, err := readEonExcelIntoPieces(path)
	if err != nil {
		return nil, err
	}
	if len(pieces) == 0 {
		return nil, fmt.Errorf("no data pieces extracted")
	}
	aggregated := mergeRowsAndAggregate(pieces)
	calculated := calculateHourlyCumulative(aggregated)

	log.Printf("[INFO] produced %d calculated hourly rows", len(calculated))

	if pushToHA {
		// build and push stats
		statsImport := buildStatsList(calculated, "1_8_0")
		statsExport := buildStatsList(calculated, "2_8_0")
		// recorder.import_statistics payload
		payloadImport := map[string]interface{}{
			"statistic_id":        entityImportStatID,
			"source":              "recorder",
			"unit_of_measurement": "kWh",
			"has_mean":            false,
			"has_sum":             true,
			"stats":               statsImport,
		}
		payloadExport := map[string]interface{}{
			"statistic_id":        entityExportStatID,
			"source":              "recorder",
			"unit_of_measurement": "kWh",
			"has_mean":            false,
			"has_sum":             true,
			"stats":               statsExport,
		}
		log.Printf("[INFO] pushing %d import stats and %d export stats", len(statsImport), len(statsExport))
		if err := callHomeAssistantService(cfg, "recorder", "import_statistics", payloadImport); err != nil {
			return calculated, fmt.Errorf("push import stats: %w", err)
		}
		if err := callHomeAssistantService(cfg, "recorder", "import_statistics", payloadExport); err != nil {
			return calculated, fmt.Errorf("push export stats: %w", err)
		}

		// update input_number entities with last state
		if cfg.UpdateInputNumbers {
			if len(statsImport) > 0 {
				last := statsImport[len(statsImport)-1]["state"].(float64)
				if err := updateInputNumber(cfg, inputNumberImport, last); err != nil {
					return calculated, fmt.Errorf("update input_number import: %w", err)
				}
				log.Printf("[INFO] updated %s -> %.3f", inputNumberImport, last)
			}
			if len(statsExport) > 0 {
				last := statsExport[len(statsExport)-1]["state"].(float64)
				if err := updateInputNumber(cfg, inputNumberExport, last); err != nil {
					return calculated, fmt.Errorf("update input_number export: %w", err)
				}
				log.Printf("[INFO] updated %s -> %.3f", inputNumberExport, last)
			}
		}
	} else {
		log.Printf("[INFO] pushToHA=false, skipping HA calls")
	}

	return calculated, nil
}

// IMAP: connect, search messages, download xlsx/xls attachments, mark seen
func fetchAttachmentsViaIMAP(cfg Config, saveDir string) ([]string, error) {
	if cfg.IMAP.Host == "" || cfg.IMAP.User == "" || cfg.IMAP.Pass == "" {
		return nil, errors.New("IMAP credentials not configured")
	}
	addr := fmt.Sprintf("%s:%d", cfg.IMAP.Host, cfg.IMAP.Port)
	log.Printf("[INFO] connecting to IMAP %s", addr)
	c, err := client.DialTLS(addr, nil)
	if err != nil {
		return nil, fmt.Errorf("imap dial: %w", err)
	}
	defer c.Logout()

	if err := c.Login(cfg.IMAP.User, cfg.IMAP.Pass); err != nil {
		return nil, fmt.Errorf("imap login: %w", err)
	}
	// select INBOX
	mbox, err := c.Select("INBOX", false)
	if err != nil {
		return nil, fmt.Errorf("select inbox: %w", err)
	}
	log.Printf("[INFO] mailbox %s has %d messages", mbox.Name, mbox.Messages)

	crit := &imap.SearchCriteria{
		WithoutFlags: []string{imap.SeenFlag},
		Header: textproto.MIMEHeader{
			"From":    {"noreply@eon.com"},
			"Subject": {"[EON-W1000]"},
		},
	}

	ids, err := c.Search(crit)
	if err != nil {
		return nil, fmt.Errorf("imap search: %w", err)
	}

	if len(ids) == 0 {
		log.Print("[INFO] no (UNSEEN) messages found")
		return nil, nil
	}

	seqset := new(imap.SeqSet)
	seqset.AddNum(ids...)

	// fetch RFC822
	section := &imap.BodySectionName{}
	items := []imap.FetchItem{section.FetchItem(), imap.FetchEnvelope}
	messages := make(chan *imap.Message, 10)
	done := make(chan error, 1)
	go func() {
		done <- c.Fetch(seqset, items, messages)
	}()

	saved := []string{}
	for msg := range messages {
		if msg == nil {
			continue
		}
		r := msg.GetBody(section)
		if r == nil {
			continue
		}
		// parse message using enmime
		mr, err := enmime.ReadEnvelope(r)
		if err != nil {
			log.Printf("[WARN] enmime parse: %v", err)
			continue
		}
		subj := mr.GetHeader("Subject")
		log.Printf("[INFO] processing message seq=%d subject=%s", msg.SeqNum, subj)
		// iterate attachments
		for _, att := range mr.Attachments {
			// att: Filename, Content
			if att.FileName == "" {
				continue
			}
			lower := strings.ToLower(att.FileName)
			if strings.HasSuffix(lower, ".xlsx") || strings.HasSuffix(lower, ".xls") {
				// save
				if saveDir == "" {
					saveDir = os.TempDir()
				}
				safe := filepath.Join(saveDir, fmt.Sprintf("%d_%s", msg.SeqNum, filepath.Base(att.FileName)))
				if err := ioutil.WriteFile(safe, att.Content, 0644); err != nil {
					log.Printf("[WARN] write attachment: %v", err)
					continue
				}
				log.Printf("[INFO] saved attachment %s", safe)
				saved = append(saved, safe)
			}
		}
		// mark seen
		seq := new(imap.SeqSet)
		seq.AddNum(msg.SeqNum)
		item := imap.FormatFlagsOp(imap.AddFlags, true)
		flags := []interface{}{imap.SeenFlag}
		if err := c.Store(seq, item, flags, nil); err != nil {
			log.Printf("[WARN] mark seen failed: %v", err)
		}
	}
	if err := <-done; err != nil {
		return saved, fmt.Errorf("fetch done err: %w", err)
	}
	return saved, nil
}

func runIMAPPollLoop(cfg Config) {
	interval := time.Duration(cfg.PollIntervalSeconds) * time.Second
	log.Printf("[INFO] starting IMAP poll loop every %s", interval)
	for {
		paths, err := fetchAttachmentsViaIMAP(cfg, "")
		if err != nil {
			log.Printf("[ERROR] IMAP fetch error: %v", err)
		} else {
			for _, p := range paths {
				if _, err := processFile(cfg, p, cfg.HomeAssistant.URL != "" && cfg.HomeAssistant.Token != ""); err != nil {
					log.Printf("[ERROR] processing file %s: %v", p, err)
				} else {
					log.Printf("[INFO] processed %s", p)
				}
			}
		}
		time.Sleep(interval)
	}
}

func main() {
	configFile := os.Getenv("CONFIG_FILE")
	if configFile == "" {
		configFile = "w1000.yaml"
	}

	cfg, err := LoadConfig(configFile)
	if err != nil {
		log.Fatalf("Config error: %v", err)
	}

	oncePath := flag.String("once", "", "process a local Excel file and exit")
	noPush := flag.Bool("no-push", false, "do not push to Home Assistant (for testing)")
	flag.Parse()

	if cfg.LogLevel == "DEBUG" {
		log.SetFlags(log.LstdFlags | log.Lshortfile)
	} else {
		log.SetFlags(log.LstdFlags)
	}

	if *oncePath != "" {
		push := !*noPush && cfg.HomeAssistant.URL != "" && cfg.HomeAssistant.Token != ""
		rows, err := processFile(cfg, *oncePath, push)
		if err != nil {
			log.Fatalf("error: %v", err)
		}
		// print a summary
		out := map[string]interface{}{"file": *oncePath, "rows": rows}
		b, _ := json.MarshalIndent(out, "", "  ")
		fmt.Println(string(b))
		return
	}

	// otherwise, run IMAP loop
	if cfg.IMAP.Host == "" || cfg.IMAP.User == "" || cfg.IMAP.Pass == "" {
		log.Fatalf("IMAP not configured; either run with --once <file> or set IMAP_HOST/IMAP_USER/IMAP_PASS")
	}
	runIMAPPollLoop(cfg)
}
