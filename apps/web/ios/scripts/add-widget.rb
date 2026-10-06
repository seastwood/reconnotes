#!/usr/bin/env ruby
# Adds the "Quick capture" Home Screen / Lock Screen widget to the Xcode project:
#   - a ReconNotesWidget target with ReconNotes' code (ios/App/Widget-src)
#   - embedded in the app, built with it, signed with the app's team
#
# Run on the Mac (once):  npm run ios:add-extensions -w @reconnotes/web
# Needs the xcodeproj gem: gem install --user-install xcodeproj
# Safe to run again: it updates the existing target instead of adding another.
require 'fileutils'
begin
  require 'xcodeproj'
rescue LoadError
  abort "The xcodeproj Ruby gem is missing. Install it with:\n  gem install --user-install xcodeproj\nthen run this again."
end

IOS = File.expand_path('../App', __dir__)
PROJECT = File.join(IOS, 'App.xcodeproj')
NAME = 'ReconNotesWidget'

project = Xcodeproj::Project.open(PROJECT)
app = project.targets.find { |t| t.name == 'App' } or abort 'No "App" target in the Xcode project'
app_settings = app.build_configurations.first.build_settings
bundle_id = app_settings['PRODUCT_BUNDLE_IDENTIFIER'] || 'com.reconnotes.app'
# TEAM=ABCDE12345 sets the signing team (on the app too), e.g. after resetting the Xcode project
team = ENV['TEAM'] || app.build_configurations.map { |c| c.build_settings['DEVELOPMENT_TEAM'] }.compact.first
app.build_configurations.each { |c| c.build_settings['DEVELOPMENT_TEAM'] = team } if ENV['TEAM']

ext_dir = File.join(IOS, NAME)
FileUtils.mkdir_p(ext_dir)
FileUtils.cp(File.join(IOS, 'Widget-src', 'QuickCaptureWidget.swift'), ext_dir)
FileUtils.cp(File.join(IOS, 'Widget-src', 'Info.plist'), ext_dir)

ext = project.targets.find { |t| t.name == NAME }
unless ext
  ext = project.new_target(:app_extension, NAME, :ios, '16.0', nil, :swift)
  group = project.main_group.find_subpath(NAME, true)
  group.set_source_tree('<group>')
  group.set_path(NAME)
  swift = group.new_reference('QuickCaptureWidget.swift')
  group.new_reference('Info.plist')
  ext.add_file_references([swift])
  %w[WidgetKit SwiftUI].each do |fw|
    ref = project.frameworks_group.new_file("System/Library/Frameworks/#{fw}.framework", :sdk_root)
    ext.frameworks_build_phase.add_file_reference(ref, true)
  end

  app.add_dependency(ext)
  embed = app.copy_files_build_phases.find { |p| p.name == 'Embed Foundation Extensions' } ||
          app.new_copy_files_build_phase('Embed Foundation Extensions')
  embed.symbol_dst_subfolder_spec = :plug_ins
  file = embed.add_file_reference(ext.product_reference, true)
  file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
end

ext.build_configurations.each do |config|
  s = config.build_settings
  s['PRODUCT_NAME'] = '$(TARGET_NAME)'
  s['PRODUCT_BUNDLE_IDENTIFIER'] = "#{bundle_id}.Widget"
  s['INFOPLIST_FILE'] = "#{NAME}/Info.plist"
  s['GENERATE_INFOPLIST_FILE'] = 'YES'
  s['INFOPLIST_KEY_CFBundleDisplayName'] = 'ReconNotes'
  s['CODE_SIGN_STYLE'] = 'Automatic'
  s['DEVELOPMENT_TEAM'] = team if team
  s['IPHONEOS_DEPLOYMENT_TARGET'] = '16.0'
  s['SWIFT_VERSION'] = '5.0'
  s['TARGETED_DEVICE_FAMILY'] = '1,2'
  s['SKIP_INSTALL'] = 'YES'
  s['MARKETING_VERSION'] = app_settings['MARKETING_VERSION'] || '1.0'
  s['CURRENT_PROJECT_VERSION'] = app_settings['CURRENT_PROJECT_VERSION'] || '1'
  s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
end

project.save
puts "Widget ready (#{bundle_id}.Widget)."
puts team ? "Signed with team #{team}." : 'Open Xcode and pick your team for the ReconNotesWidget target (Signing & Capabilities).'
